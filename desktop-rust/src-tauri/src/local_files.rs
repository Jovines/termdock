//! Original paths require both the current service's pinned identity and this
//! machine's public key, never a loopback hostname or clipboard path-like text.
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub fn verified_local(home: &Path, pinned: Option<&str>, requested: Option<&str>) -> bool {
    let Some(peer) = pinned.filter(|p| Some(*p) == requested) else {
        return false;
    };
    let Ok(file) = open_regular(&home.join(".termdock/federation/identity.key")) else {
        return false;
    };
    let mut encoded = String::new();
    if file.take(257).read_to_string(&mut encoded).is_err() || encoded.len() > 256 {
        return false;
    }
    let Ok(key) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else {
        return false;
    };
    if key.len() != 68 || key[..4] != [8, 1, 18, 64] {
        return false;
    }
    // Only the Ed25519 public half is encoded and compared; no key is exposed.
    let mut public = vec![0, 36, 8, 1, 18, 32];
    public.extend_from_slice(&key[36..]);
    bs58::encode(public).into_string() == peer
}

pub const MAX_BYTES: u64 = 128 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_FILES: usize = 50;
fn open_regular(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("请选择文件；文件夹不能上传到远端".into());
    }
    Ok(file)
}
const MAX_BATCHES: usize = 8;
const IDLE: Duration = Duration::from_secs(30);
const LIFETIME: Duration = Duration::from_secs(300);
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Owner {
    pub window: String,
    pub target: String,
}
#[derive(Clone)]
pub struct Input {
    pub path: PathBuf,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub reusable: bool,
}
impl Input {
    pub fn selected(path: PathBuf) -> Self {
        Self {
            path,
            name: None,
            mime: None,
            reusable: true,
        }
    }
}
struct OpenFile {
    file: fs::File,
    length: u64,
    offset: u64,
}
struct Batch {
    files: Vec<OpenFile>,
    owner: Owner,
    reserved: u64,
    next: usize,
    seq: u64,
    receipt: Option<String>,
    created: Instant,
    touched: Instant,
    // Drop after the open handles, including on Windows.
    _temporary: Option<tempfile::TempDir>,
}
#[derive(Default)]
pub struct Transfers {
    batches: BTreeMap<String, Batch>,
}
impl Transfers {
    pub fn purge(&mut self) {
        self.purge_at(Instant::now());
    }
    fn purge_at(&mut self, now: Instant) {
        self.batches.retain(|_, b| {
            now.duration_since(b.touched) < IDLE && now.duration_since(b.created) < LIFETIME
        });
    }
    pub fn close_window(&mut self, window: &str) {
        self.batches.retain(|_, b| b.owner.window != window);
    }
    pub fn retain_owners(&mut self, valid: impl Fn(&Owner) -> bool) {
        self.batches.retain(|_, b| valid(&b.owner));
    }
    pub fn usage(&self) -> (usize, u64) {
        (
            self.batches.len(),
            self.batches.values().map(|b| b.reserved).sum(),
        )
    }
    pub fn prepare(
        &mut self,
        owner: Owner,
        inputs: Vec<Input>,
        local: bool,
        temporary: Option<tempfile::TempDir>,
    ) -> Result<Value, String> {
        self.purge();
        if inputs.len() > MAX_FILES {
            return Err("Choose up to 50 files; none were read".into());
        }
        let mut rows = Vec::with_capacity(inputs.len());
        let mut opened = Vec::new();
        let mut total = 0u64;
        for input in inputs {
            let name = input.name.unwrap_or_else(|| {
                input
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
            if local && input.reusable {
                fs::metadata(&input.path).map_err(|e| e.to_string())?;
                rows.push(json!({"name":name,"path":input.path,"type":input.mime.unwrap_or_else(||"application/octet-stream".into())}));
                continue;
            }
            // A path replaced with a FIFO must not stall the reader thread.
            let file = open_regular(&input.path)?;
            let metadata = file.metadata().map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                return Err("请选择文件；文件夹不能上传到远端".into());
            }
            total = total
                .checked_add(metadata.len())
                .ok_or("File size overflow")?;
            if total > MAX_BYTES {
                return Err("Selected files exceed 128 MiB; no files were uploaded".into());
            }
            rows.push(json!({"name":name,"type":input.mime.unwrap_or_else(||"application/octet-stream".into()),"size":metadata.len(),"index":opened.len()}));
            opened.push(OpenFile {
                file,
                length: metadata.len(),
                offset: 0,
            });
        }
        if opened.is_empty() {
            return Ok(json!({"batch":null,"files":rows}));
        }
        let (count, reserved) = self.usage();
        if count >= MAX_BATCHES || reserved.checked_add(total).is_none_or(|n| n > MAX_BYTES) {
            return Err(
                "Preview file reads are busy; finish or cancel the current read before retrying"
                    .into(),
            );
        }
        let token = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        self.batches.insert(
            token.clone(),
            Batch {
                files: opened,
                owner,
                reserved: total,
                next: 0,
                seq: 0,
                receipt: None,
                created: now,
                touched: now,
                _temporary: temporary,
            },
        );
        Ok(json!({"batch":token,"files":rows}))
    }
    pub fn chunk(
        &mut self,
        owner: &Owner,
        token: &str,
        index: usize,
        seq: u64,
        receipt: Option<&str>,
    ) -> Result<Value, String> {
        self.purge();
        let batch = self
            .batches
            .get(token)
            .ok_or("File read expired or was cancelled")?;
        if batch.owner.window != owner.window {
            return Err("File read belongs to another window".into());
        }
        if &batch.owner != owner {
            self.batches.remove(token);
            return Err("File read target changed".into());
        }
        let result = self.chunk_inner(token, index, seq, receipt);
        if result.is_err() {
            self.batches.remove(token);
        }
        result
    }
    fn chunk_inner(
        &mut self,
        token: &str,
        index: usize,
        seq: u64,
        receipt: Option<&str>,
    ) -> Result<Value, String> {
        let batch = self.batches.get_mut(token).unwrap();
        if index != batch.next || seq != batch.seq || receipt != batch.receipt.as_deref() {
            return Err("Invalid or replayed file read sequence/receipt".into());
        }
        let file = batch
            .files
            .get_mut(index)
            .ok_or("File read index out of bounds")?;
        if file.file.metadata().map_err(|e| e.to_string())?.len() != file.length {
            return Err("Selected file changed size; choose it again".into());
        }
        let count = (file.length - file.offset).min(CHUNK_BYTES as u64) as usize;
        let mut bytes = vec![0; count];
        file.file
            .read_exact(&mut bytes)
            .map_err(|_| "Selected file was truncated while reading")?;
        let offset = file.offset;
        file.offset += count as u64;
        let eof = file.offset == file.length;
        if eof {
            // Bounded sentinel read catches growth after the preceding fstat.
            let mut extra = [0];
            if file.file.read(&mut extra).map_err(|e| e.to_string())? != 0 {
                return Err("Selected file grew while reading".into());
            }
            batch.next += 1;
        }
        batch.seq += 1;
        let receipt = uuid::Uuid::new_v4().to_string();
        batch.receipt = Some(receipt.clone());
        batch.touched = Instant::now();
        Ok(
            json!({"index":index,"seq":seq,"offset":offset,"length":count,"eof":eof,"receipt":receipt,"base64":base64::engine::general_purpose::STANDARD.encode(&bytes)}),
        )
    }
    pub fn release(&mut self, owner: &Owner, token: &str) -> Result<(), String> {
        self.purge();
        if self
            .batches
            .get(token)
            .is_some_and(|b| b.owner.window != owner.window)
        {
            return Err("File read belongs to another window".into());
        }
        // Cancellation is permitted after this same window's target changes.
        self.batches.remove(token);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn owner(window: &str, target: &str) -> Owner {
        Owner {
            window: window.into(),
            target: target.into(),
        }
    }
    fn prepare(store: &mut Transfers, who: &Owner, paths: Vec<PathBuf>) -> Value {
        store
            .prepare(
                who.clone(),
                paths.into_iter().map(Input::selected).collect(),
                false,
                None,
            )
            .unwrap()
    }
    #[test]
    fn real_128_mib_and_50_file_limits_use_fixed_size_linear_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sparse.bin");
        fs::File::create(&path).unwrap().set_len(MAX_BYTES).unwrap();
        let mut store = Transfers::default();
        let who = owner("one", "target");
        let selected = prepare(&mut store, &who, vec![path.clone()]);
        let token = selected["batch"].as_str().unwrap();
        assert_eq!(selected["files"][0]["size"], MAX_BYTES);
        let mut receipt: Option<String> = None;
        let mut actual = 0;
        for seq in 0..MAX_BYTES / CHUNK_BYTES as u64 {
            let chunk = store
                .chunk(&who, token, 0, seq, receipt.as_deref())
                .unwrap();
            assert_eq!(chunk["length"], CHUNK_BYTES);
            assert!(chunk.get("bytes").is_none());
            let encoded = chunk["base64"].as_str().unwrap();
            assert_eq!(encoded.len(), 4 * CHUNK_BYTES.div_ceil(3));
            assert!(serde_json::to_vec(&chunk).unwrap().len() < CHUNK_BYTES * 2);
            actual += base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap()
                .len() as u64;
            receipt = chunk["receipt"].as_str().map(str::to_owned);
        }
        assert_eq!(actual, MAX_BYTES);
        store.release(&who, token).unwrap();
        assert_eq!(store.usage(), (0, 0));
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(store
            .prepare(who.clone(), vec![Input::selected(path)], false, None)
            .is_err());
        let tiny = dir.path().join("tiny");
        fs::write(&tiny, b"x").unwrap();
        let selected = prepare(&mut store, &who, vec![tiny.clone(); MAX_FILES]);
        let token = selected["batch"].as_str().unwrap();
        let mut receipt = None;
        for i in 0..MAX_FILES {
            let chunk = store
                .chunk(&who, token, i, i as u64, receipt.as_deref())
                .unwrap();
            assert_eq!(chunk["base64"], "eA==");
            receipt = chunk["receipt"].as_str().map(str::to_owned);
        }
        store.release(&who, token).unwrap();
        assert!(store
            .prepare(who, vec![Input::selected(tiny); MAX_FILES + 1], false, None)
            .is_err());
    }
    #[test]
    fn real_growth_truncation_and_open_handle_replacement_fail_without_unbounded_read() {
        for grow in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("mutable");
            fs::write(&path, vec![7; CHUNK_BYTES + 2]).unwrap();
            let mut store = Transfers::default();
            let who = owner("one", "target");
            let selected = prepare(&mut store, &who, vec![path.clone()]);
            let token = selected["batch"].as_str().unwrap();
            let first = store.chunk(&who, token, 0, 0, None).unwrap();
            if grow {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap()
                    .write_all(b"growth")
                    .unwrap();
            } else {
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_len(1)
                    .unwrap();
            }
            assert!(store
                .chunk(&who, token, 0, 1, first["receipt"].as_str())
                .unwrap_err()
                .contains("changed size"));
            assert_eq!(store.usage(), (0, 0));
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("selected");
        fs::write(&path, b"original").unwrap();
        let who = owner("one", "target");
        let mut store = Transfers::default();
        let selection = prepare(&mut store, &who, vec![path.clone()]);
        fs::rename(&path, dir.path().join("old")).unwrap();
        fs::write(&path, b"replacement").unwrap();
        let chunk = store
            .chunk(&who, selection["batch"].as_str().unwrap(), 0, 0, None)
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["base64"].as_str().unwrap())
                .unwrap(),
            b"original"
        );
    }
    #[test]
    fn owner_target_sequence_receipt_and_index_are_bound_and_errors_release() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data");
        fs::write(&path, vec![42; CHUNK_BYTES + 1]).unwrap();
        let who = owner("one", "target");
        let mut store = Transfers::default();
        let selected = prepare(&mut store, &who, vec![path.clone()]);
        let token = selected["batch"].as_str().unwrap();
        assert!(store
            .chunk(&owner("two", "target"), token, 0, 0, None)
            .is_err());
        assert!(store.release(&owner("two", "target"), token).is_err());
        assert_eq!(store.usage().0, 1);
        assert!(store
            .chunk(&owner("one", "different target"), token, 0, 0, None)
            .is_err());
        assert_eq!(store.usage(), (0, 0));
        for replay in 0..3 {
            let selected = prepare(&mut store, &who, vec![path.clone()]);
            let token = selected["batch"].as_str().unwrap();
            let first = store.chunk(&who, token, 0, 0, None).unwrap();
            let (index, seq, receipt) = match replay {
                0 => (0, 0, first["receipt"].as_str()),
                1 => (0, 1, None),
                _ => (1, 1, first["receipt"].as_str()),
            };
            assert!(store.chunk(&who, token, index, seq, receipt).is_err());
            assert_eq!(store.usage(), (0, 0));
        }
    }
    #[test]
    fn global_budget_multiple_files_concurrency_cancel_expiry_and_temp_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sparse");
        fs::File::create(&path)
            .unwrap()
            .set_len(80 * 1024 * 1024)
            .unwrap();
        let store = std::sync::Arc::new(std::sync::Mutex::new(Transfers::default()));
        let mut threads = Vec::new();
        for window in ["one", "two"] {
            let store = store.clone();
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                store.lock().unwrap().prepare(
                    owner(window, "target"),
                    vec![Input::selected(path)],
                    false,
                    None,
                )
            }));
        }
        let results = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let mut store = store.lock().unwrap();
        assert_eq!(store.usage(), (1, 80 * 1024 * 1024));
        let window = store.batches.values().next().unwrap().owner.window.clone();
        store.close_window(&window);
        assert_eq!(store.usage(), (0, 0));
        assert!(store
            .prepare(
                owner("one", "target"),
                vec![Input::selected(path.clone()), Input::selected(path)],
                false,
                None
            )
            .is_err());
        assert_eq!(store.usage(), (0, 0));
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let file = root.join("movie");
        fs::write(&file, b"video").unwrap();
        let who = owner("one", "target");
        let selected = store
            .prepare(
                who.clone(),
                vec![Input {
                    path: file,
                    name: Some("clip.mov".into()),
                    mime: Some("video/quicktime".into()),
                    reusable: false,
                }],
                true,
                Some(temp),
            )
            .unwrap();
        let token = selected["batch"].as_str().unwrap();
        assert!(selected["files"][0].get("path").is_none());
        store
            .release(&owner("one", "changed target"), token)
            .unwrap();
        assert!(!root.exists());
        assert_eq!(store.usage(), (0, 0));
        let file = dir.path().join("empty");
        fs::write(&file, []).unwrap();
        for _ in 0..MAX_BATCHES {
            prepare(&mut store, &who, vec![file.clone()]);
        }
        assert!(store
            .prepare(
                who.clone(),
                vec![Input::selected(file.clone())],
                false,
                None
            )
            .is_err());
        let now = Instant::now();
        store.purge_at(now + IDLE);
        assert_eq!(store.usage(), (0, 0));
        prepare(&mut store, &who, vec![file]);
        store.batches.values_mut().next().unwrap().created = Instant::now() - LIFETIME;
        store.purge();
        assert_eq!(store.usage(), (0, 0));
    }
    #[test]
    fn local_paths_require_current_pinned_public_identity_and_remote_paths_are_never_returned() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".termdock/federation")).unwrap();
        let mut key = vec![8, 1, 18, 64];
        key.extend([7; 64]);
        fs::write(
            dir.path().join(".termdock/federation/identity.key"),
            base64::engine::general_purpose::STANDARD.encode(&key),
        )
        .unwrap();
        let mut public = vec![0, 36, 8, 1, 18, 32];
        public.extend(&key[36..]);
        let peer = bs58::encode(public).into_string();
        assert!(verified_local(dir.path(), Some(&peer), Some(&peer)));
        assert!(!verified_local(dir.path(), Some("remote"), Some(&peer)));
        assert!(!verified_local(dir.path(), Some(&peer), None));
        let path = dir.path().join("file");
        fs::write(&path, b"private bytes").unwrap();
        let who = owner("one", "target");
        let mut store = Transfers::default();
        let remote = prepare(&mut store, &who, vec![path.clone()]);
        assert!(remote["files"][0].get("path").is_none());
        assert!(remote["files"][0].get("bytes").is_none());
        let local = store
            .prepare(who, vec![Input::selected(path)], true, None)
            .unwrap();
        assert!(local["batch"].is_null());
        assert_eq!(local["files"][0]["name"], "file");
    }
}
