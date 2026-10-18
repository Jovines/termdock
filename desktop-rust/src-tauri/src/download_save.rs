//! Owner-bound, one-shot native save transfers for bytes fetched by the page.
use crate::local_files::{Owner, CHUNK_BYTES};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;

const MAX_WRITES: usize = 4;
const MAX_PROTOCOL_BYTES: u64 = 9_007_199_254_740_991;
pub fn expected_size(value:&Value)->Result<Option<u64>,String>{
    if value.is_null(){return Ok(None);}
    value.as_u64().filter(|size|*size<=MAX_PROTOCOL_BYTES).map(Some).ok_or("Invalid native save size or protocol integer range".into())
}
const IDLE: Duration = Duration::from_secs(30);
struct WriteBatch {
    owner: Owner,
    destination: PathBuf,
    file: NamedTempFile,
    expected: Option<u64>,
    written: u64,
    seq: u64,
    receipt: String,
    touched: Instant,
}
#[derive(Default)]
pub struct DownloadWrites {
    batches: BTreeMap<String, WriteBatch>,
}
impl DownloadWrites {
    fn purge(&mut self) {
        self.batches.retain(|_, b| b.touched.elapsed() < IDLE);
    }
    pub fn close_window(&mut self, window: &str) {
        self.batches.retain(|_, b| b.owner.window != window);
    }
    pub fn retain_owners(&mut self, valid: impl Fn(&Owner) -> bool) {
        self.purge();
        self.batches.retain(|_, b| valid(&b.owner));
    }
    pub fn begin(
        &mut self,
        owner: Owner,
        destination: PathBuf,
        expected: Option<u64>,
    ) -> Result<Value, String> {
        self.purge();
        if expected.is_some_and(|size|size>MAX_PROTOCOL_BYTES) {
            return Err("Download size exceeds the protocol integer range".into());
        }
        if destination.file_name().is_none() || !destination.parent().is_some_and(Path::is_dir) {
            return Err("Invalid native save destination".into());
        }
        if self.batches.len() >= MAX_WRITES {
            return Err("Preview saves are busy".into());
        }
        let parent = destination.parent().unwrap();
        let file = tempfile::Builder::new()
            .prefix(".termdock-download-")
            .tempfile_in(parent)
            .map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().to_string();
        let receipt = uuid::Uuid::new_v4().to_string();
        self.batches.insert(
            token.clone(),
            WriteBatch {
                owner,
                destination,
                file,
                expected,
                written: 0,
                seq: 0,
                receipt: receipt.clone(),
                touched: Instant::now(),
            },
        );
        Ok(json!({"batch":token,"seq":0,"receipt":receipt,"chunkBytes":CHUNK_BYTES}))
    }
    pub fn chunk(
        &mut self,
        owner: &Owner,
        token: &str,
        seq: u64,
        receipt: &str,
        bytes: &[u8],
    ) -> Result<Value, String> {
        self.purge();
        let batch = self
            .batches
            .get_mut(token)
            .ok_or("Native save expired or was cancelled")?;
        if &batch.owner != owner {
            self.batches.remove(token);
            return Err("Native save target changed".into());
        }
        if seq != batch.seq
            || receipt != batch.receipt
            || bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || batch
                .written
                .checked_add(bytes.len() as u64)
                .is_none_or(|n| n>MAX_PROTOCOL_BYTES||batch.expected.is_some_and(|expected|n>expected))
        {
            self.batches.remove(token);
            return Err("Invalid or replayed native save chunk".into());
        }
        if batch.file.write_all(bytes).is_err() {
            self.batches.remove(token);
            return Err("Could not write downloaded file".into());
        }
        batch.written += bytes.len() as u64;
        batch.seq += 1;
        batch.receipt = uuid::Uuid::new_v4().to_string();
        batch.touched = Instant::now();
        Ok(json!({"written":batch.written,"seq":batch.seq,"receipt":batch.receipt}))
    }
    pub fn finish(
        &mut self,
        owner: &Owner,
        token: &str,
        seq: u64,
        receipt: &str,
        written: u64,
    ) -> Result<(), String> {
        self.purge();
        let batch = self
            .batches
            .get(token)
            .ok_or("Native save expired or was cancelled")?;
        if &batch.owner != owner {
            self.batches.remove(token);
            return Err("Native save target changed".into());
        }
        if seq != batch.seq || receipt != batch.receipt || written != batch.written || batch.expected.is_some_and(|expected|written!=expected) {
            self.batches.remove(token);
            return Err("Native save is incomplete".into());
        }
        let batch = self.batches.remove(token).unwrap();
        batch.file.as_file().sync_all().map_err(|e| e.to_string())?;
        batch
            .file
            .persist(&batch.destination)
            .map_err(|e| e.error.to_string())?;
        Ok(())
    }
    pub fn cancel(&mut self, window: &str, token: &str) -> Result<(), String> {
        self.purge();
        if self
            .batches
            .get(token)
            .is_some_and(|b| b.owner.window != window)
        {
            return Err("Native save belongs to another window".into());
        }
        self.batches.remove(token);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(target: &str) -> Owner {
        Owner {
            window: "service".into(),
            target: target.into(),
        }
    }
    #[test]
    fn host_start_parses_unknown_and_large_lengths_without_the_upload_cap() {
        assert_eq!(expected_size(&Value::Null).unwrap(),None);
        assert_eq!(expected_size(&json!(129*1024*1024)).unwrap(),Some(129*1024*1024));
        assert_eq!(expected_size(&json!(0)).unwrap(),Some(0));
        for value in [json!(-1),json!(0.5),json!("129"),json!(true),json!(MAX_PROTOCOL_BYTES+1)]{assert!(expected_size(&value).is_err());}
        let source=include_str!("shell.rs");let branch=source.split_once("\"downloadStart\" => {").unwrap().1.split_once("\"downloadChunk\" => {").unwrap().0;
        assert!(branch.contains("download_save::expected_size(&args[\"size\"])?"));assert!(!branch.contains("MAX_BYTES"));
    }
    #[test]
    fn unknown_lengths_empty_files_and_finish_counts_are_verified() {
        let dir=tempfile::tempdir().unwrap();let mut writes=DownloadWrites::default();
        let destination=dir.path().join("unknown.bin");let start=writes.begin(owner("a"),destination.clone(),None).unwrap();let token=start["batch"].as_str().unwrap();
        let next=writes.chunk(&owner("a"),token,0,start["receipt"].as_str().unwrap(),b"abc").unwrap();
        writes.finish(&owner("a"),token,1,next["receipt"].as_str().unwrap(),3).unwrap();assert_eq!(std::fs::read(destination).unwrap(),b"abc");
        for expected in [None,Some(0)] {let empty=dir.path().join(if expected.is_none(){"empty-unknown"}else{"empty-known"});let start=writes.begin(owner("a"),empty.clone(),expected).unwrap();writes.finish(&owner("a"),start["batch"].as_str().unwrap(),0,start["receipt"].as_str().unwrap(),0).unwrap();assert_eq!(std::fs::metadata(empty).unwrap().len(),0);}
        let bad=dir.path().join("bad-count");let start=writes.begin(owner("a"),bad.clone(),None).unwrap();assert!(writes.finish(&owner("a"),start["batch"].as_str().unwrap(),0,start["receipt"].as_str().unwrap(),1).is_err());assert!(!bad.exists());
        let over=dir.path().join("over");let start=writes.begin(owner("a"),over.clone(),Some(1)).unwrap();assert!(writes.chunk(&owner("a"),start["batch"].as_str().unwrap(),0,start["receipt"].as_str().unwrap(),b"ab").is_err());assert!(!over.exists());
    }
    #[test]
    fn streamed_files_larger_than_the_previous_total_cap_are_persisted() {
        let dir=tempfile::tempdir().unwrap();let destination=dir.path().join("large.bin");let mut writes=DownloadWrites::default();let length=129*1024*1024;
        let start=writes.begin(owner("a"),destination.clone(),Some(length)).unwrap();let token=start["batch"].as_str().unwrap();let mut receipt=start["receipt"].as_str().unwrap().to_owned();let block=vec![b'x';CHUNK_BYTES];let mut written=0;let mut seq=0;
        while written<length {let next=writes.chunk(&owner("a"),token,seq,&receipt,&block).unwrap();seq+=1;written+=CHUNK_BYTES as u64;receipt=next["receipt"].as_str().unwrap().to_owned();}
        writes.finish(&owner("a"),token,seq,&receipt,written).unwrap();assert_eq!(std::fs::metadata(destination).unwrap().len(),length);
    }
    #[test]
    fn filesystem_persist_failure_never_reports_saved_or_removes_the_existing_destination() {
        let dir=tempfile::tempdir().unwrap();let destination=dir.path().join("occupied");let mut writes=DownloadWrites::default();let start=writes.begin(owner("a"),destination.clone(),None).unwrap();std::fs::create_dir(&destination).unwrap();
        assert!(writes.finish(&owner("a"),start["batch"].as_str().unwrap(),0,start["receipt"].as_str().unwrap(),0).is_err());assert!(destination.is_dir());assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),1);
    }
    #[test]
    fn periodic_owner_reap_also_removes_expired_partial_files() {
        let dir=tempfile::tempdir().unwrap();let mut writes=DownloadWrites::default();
        let token=writes.begin(owner("a"),dir.path().join("out.bin"),Some(3)).unwrap()["batch"].as_str().unwrap().to_owned();
        let batch=writes.batches.get_mut(&token).unwrap();let temporary=batch.file.path().to_owned();
        batch.touched=Instant::now()-IDLE-Duration::from_secs(1);
        writes.retain_owners(|_|true);
        assert!(writes.batches.is_empty());assert!(!temporary.exists());
    }
    #[test]
    fn writes_in_one_time_bounded_chunks_and_only_reports_saved_after_persist() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.bin");
        let mut writes = DownloadWrites::default();
        let started = writes.begin(owner("a"), destination.clone(), Some(3)).unwrap();
        let token = started["batch"].as_str().unwrap().to_owned();
        let receipt = started["receipt"].as_str().unwrap().to_owned();
        let next = writes
            .chunk(&owner("a"), &token, 0, &receipt, b"abc")
            .unwrap();
        let next_receipt = next["receipt"].as_str().unwrap();
        writes.finish(&owner("a"), &token, 1, next_receipt, 3).unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"abc");
        assert!(writes
            .chunk(&owner("a"), &token, 1, next_receipt, b"x")
            .is_err());
        let incomplete = dir.path().join("incomplete.bin");
        let pending = writes.begin(owner("a"), incomplete.clone(), Some(1)).unwrap();
        assert!(writes
            .finish(
                &owner("a"),
                pending["batch"].as_str().unwrap(),
                0,
                pending["receipt"].as_str().unwrap(),
                0
            )
            .is_err());
        assert!(!incomplete.exists());
    }
    #[test]
    fn a_target_change_and_cancel_never_leave_a_destination_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.bin");
        let mut writes = DownloadWrites::default();
        let started = writes.begin(owner("a"), destination.clone(), Some(1)).unwrap();
        let token = started["batch"].as_str().unwrap();
        let receipt = started["receipt"].as_str().unwrap();
        assert!(writes.chunk(&owner("b"), token, 0, receipt, b"x").is_err());
        assert!(!destination.exists());
        let second = writes.begin(owner("a"), destination.clone(), Some(1)).unwrap();
        writes
            .cancel("service", second["batch"].as_str().unwrap())
            .unwrap();
        assert!(!destination.exists());
    }
}
