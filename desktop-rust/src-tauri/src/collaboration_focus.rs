use crate::config::{origin, Connection};

/// Collaboration IDs contain independently URI-encoded origin and session fields.
/// Do not use form decoding: a literal '+' is part of a session ID.
pub fn address(value: &str) -> Option<(String, String)> {
    fn decode(value: &str) -> Option<String> {
        let mut bytes = Vec::new();
        let mut input = value.bytes();
        while let Some(byte) = input.next() {
            bytes.push(if byte == b'%' {
                let high = (input.next()? as char).to_digit(16)?;
                let low = (input.next()? as char).to_digit(16)?;
                (high * 16 + low) as u8
            } else { byte });
        }
        String::from_utf8(bytes).ok()
    }
    if value.len() > 8192 { return None; }
    let (encoded_origin, encoded_session) = value.strip_prefix("remote:")?.split_once(':')?;
    if encoded_session.contains(':') { return None; }
    let service = decode(encoded_origin)?;
    if origin(&service).ok()? != service { return None; }
    let session = decode(encoded_session)?;
    if session.is_empty() || session.len() > 512 || session.chars().any(char::is_control) { return None; }
    Some((service, session))
}
fn matches(connection: &Connection, address: &str) -> bool {
    connection.service_origin.as_deref().unwrap_or(&connection.url) == address
        || connection.routes.iter().any(|route| route.url == address
            && connection.target_peer_id.as_deref() == Some(route.target_peer_id.as_str()))
}
/// Reuse an open window by an exact target address or an unambiguous saved peer
/// identity. A relay's entry origin alone is not the target service's address.
pub fn window(address: &str, open: &[(String, Connection)], saved: &[Connection]) -> Option<String> {
    let peers = open.iter().map(|(_, c)| c).chain(saved.iter())
        .filter(|c| matches(c, address)).filter_map(|c| c.target_peer_id.as_deref())
        .collect::<std::collections::BTreeSet<_>>();
    if peers.len() > 1 { return None; }
    open.iter().find(|(_, c)| matches(c, address)
        || c.target_peer_id.as_deref().is_some_and(|peer| peers.contains(peer)))
        .map(|(label, _)| label.clone())
}
/// An authenticated peer-directory lookup can identify a saved window even
/// when that node's registered origin is not a route of the caller's window.
/// This only focuses an existing pinned window; it grants no network route.
pub fn peer_window(peer:&str,open:&[(String,Connection)])->Option<String>{
 open.iter().find(|(_,c)|c.target_peer_id.as_deref()==Some(peer)).map(|(label,_)|label.clone())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn connection(url: &str, peer: Option<&str>) -> Connection {
        Connection { id: url.into(), url: url.into(), label: "service".into(), target_peer_id: peer.map(str::to_owned), service_origin: None, entry_service_id: None, routes: vec![] }
    }
    #[test]
    fn decodes_session_without_turning_plus_into_space() {
        assert_eq!(address("remote:https%3A%2F%2Ftarget.test:one%3Atwo+%E4%B8%AD"), Some(("https://target.test".into(), "one:two+中".into())));
        for id in ["local", "remote:javascript%3Aalert(1):x", "remote:https%3A%2F%2Fa.test%2Fx:s", "remote:https%3A%2F%2Fa.test:", "remote:https%3A%2F%2Fa.test:a:b", "remote:https%3A%2F%2Fa.test:%FF", "remote:https%3A%2F%2Fa.test:%0A"] { assert!(address(id).is_none(), "{id}"); }
    }
    #[test]
    fn selects_target_instead_of_callers_window() {
        let open = vec![("caller".into(), connection("https://caller.test", Some("a"))), ("target".into(), connection("https://target.test", Some("b")))];
        assert_eq!(window("https://target.test", &open, &[]).as_deref(), Some("target"));
        assert_eq!(window("https://missing.test", &open, &[]), None);
    }
    #[test]
    fn saved_alias_resolves_to_existing_pinned_window() {
        let open = vec![("target".into(), connection("https://other-address.test", Some("b")))];
        assert_eq!(window("https://target.test", &open, &[connection("https://target.test", Some("b"))]).as_deref(), Some("target"));
        assert_eq!(window("https://target.test", &open, &[connection("https://target.test", Some("b")), connection("https://target.test", Some("c"))]), None);
    }
    #[test]
    fn registered_origin_alias_focuses_only_the_saved_pinned_peer(){
        let open=vec![("caller".into(),connection("https://caller.test",Some("caller"))),("already-open".into(),connection("https://127.0.0.1:9834",Some("target")))];
        assert_eq!(peer_window("target",&open).as_deref(),Some("already-open"));
        assert_eq!(peer_window("unknown",&open),None);
    }
    #[test]
    fn relay_entry_does_not_impersonate_target() {
        let mut c = connection("https://entry.test", Some("target"));
        c.service_origin = Some("https://target.test".into());
        c.entry_service_id = Some("entry".into());
        let open = vec![("target".into(), c)];
        assert_eq!(window("https://entry.test", &open, &[]), None);
        assert_eq!(window("https://target.test", &open, &[]).as_deref(), Some("target"));
    }
}
