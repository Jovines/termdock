//! Bounded, pointer-free metadata shared with async close dispatch. Actual
//! NativePanels stay in main-thread TLS; every replacement has a fresh token.
use std::collections::{BTreeMap,VecDeque};
#[derive(Clone,Debug,PartialEq,Eq)]
pub struct ViewStamp {pub window:String,pub service:String,pub target:String,pub view:String,pub token:String}
#[derive(Default)]
pub struct Registry {entries:BTreeMap<(String,String),ViewStamp>,superseded:VecDeque<ViewStamp>}
#[derive(Debug,PartialEq,Eq)]
pub enum Retirement {Absent,Current,Superseded{replacement_token:String}}
#[derive(Clone,Default)]
pub struct CloseSnapshot {entries:BTreeMap<(String,String),ViewStamp>}
impl Registry {
 pub fn replace(&mut self,entries:impl IntoIterator<Item=ViewStamp>)->Result<(),String>{
  let mut next=BTreeMap::new();
  for entry in entries{if next.len()>=32{return Err("Native close metadata exceeds surface bound".into());}next.insert((entry.window.clone(),entry.view.clone()),entry);}
  for (key,previous) in &self.entries {
   if next.get(key)!=Some(previous) {
    self.superseded.push_back(previous.clone());
    if self.superseded.len()>128 {self.superseded.pop_front();}
   }
  }
  self.entries=next;Ok(())
 }
 pub fn retirement(&self,requested:&ViewStamp)->Result<Retirement,String>{
  let Some(current)=self.entries.get(&(requested.window.clone(),requested.view.clone())) else{
   return if self.superseded.iter().any(|old|old==requested){Ok(Retirement::Absent)}else{Err("Native retirement does not match a known absent owner".into())};
  };
  if current==requested{return Ok(Retirement::Current)}
  if current.window==requested.window&&current.service==requested.service&&current.target==requested.target
    &&self.superseded.iter().any(|old|old==requested){
   return Ok(Retirement::Superseded{replacement_token:current.token.clone()});
  }
  Err("Native retirement does not match a known surface owner".into())
 }
 pub fn capture(&self,window:&str,service:&str,target:&str)->CloseSnapshot{
  CloseSnapshot{entries:self.entries.iter().filter(|(_,entry)|entry.window==window&&entry.service==service&&entry.target==target).map(|(key,value)|(key.clone(),value.clone())).collect()}
 }
}
impl CloseSnapshot {
 pub fn includes(&self,entry:&ViewStamp)->bool{self.entries.get(&(entry.window.clone(),entry.view.clone()))==Some(entry)}
 pub fn permits_view(&self,current:Option<&ViewStamp>)->bool{current.is_none_or(|entry|self.includes(entry))}
}
#[cfg(test)]
mod tests {
 use super::*;
 fn stamp(view:&str,token:&str)->ViewStamp{ViewStamp{window:"w".into(),service:"s".into(),target:"t".into(),view:view.into(),token:token.into()}}
 #[test]
 fn capture_before_enqueue_rejects_rebind_restore_drop_recreate_and_absent_then_create(){
  let mut registry=Registry::default();let first=stamp("panel","before");registry.replace([first.clone()]).unwrap();
  let queued=registry.capture("w","s","t");let replacement=stamp("panel","after");registry.replace([replacement.clone()]).unwrap();assert!(!queued.permits_view(Some(&replacement)));
  registry.replace([]).unwrap();assert!(queued.permits_view(None));let absent=registry.capture("w","s","t");registry.replace([replacement.clone()]).unwrap();assert!(!absent.permits_view(Some(&replacement)));assert!(!queued.permits_view(Some(&replacement)));
 }
 #[test]
 fn unrelated_creates_do_not_invalidate_exact_close_and_bulk_scope_preserves_new_tokens(){
  let mut registry=Registry::default();let old=stamp("old","a");registry.replace([old.clone()]).unwrap();let queued=registry.capture("w","s","t");
  let new=stamp("new","b");registry.replace([old.clone(),new.clone()]).unwrap();assert!(queued.permits_view(Some(&old)));assert!(!queued.includes(&new));
  let replaced=stamp("old","new-generation");assert!(!queued.includes(&replaced));assert!(!registry.capture("w","other-service","t").includes(&old));
 }
 #[test]
 fn metadata_bound_rejection_keeps_the_previous_trusted_snapshot(){
  let mut registry=Registry::default();let old=stamp("old","a");registry.replace([old.clone()]).unwrap();assert!(registry.replace((0..33).map(|n|stamp(&format!("panel-{n}"),"token"))).is_err());assert!(registry.capture("w","s","t").includes(&old));
 }
 #[test]
 fn retirement_requires_exact_known_owner_and_never_drops_a_replacement(){
  let mut registry=Registry::default();let old=stamp("panel","old");let new=stamp("panel","new");
  registry.replace([old.clone()]).unwrap();assert_eq!(registry.retirement(&old).unwrap(),Retirement::Current);
  registry.replace([new.clone()]).unwrap();assert_eq!(registry.retirement(&old).unwrap(),Retirement::Superseded{replacement_token:"new".into()});
  assert!(registry.retirement(&stamp("panel","unknown")).is_err());let mut wrong=old.clone();wrong.target="other".into();assert!(registry.retirement(&wrong).is_err());
  registry.replace([]).unwrap();assert_eq!(registry.retirement(&old).unwrap(),Retirement::Absent);assert!(registry.retirement(&stamp("panel","never-seen")).is_err());
  registry.replace([new]).unwrap();assert_eq!(registry.retirement(&old).unwrap(),Retirement::Superseded{replacement_token:"new".into()});
  for n in 0..130 {registry.replace([stamp("panel",&format!("n-{n}"))]).unwrap();}
  assert!(registry.retirement(&old).is_err());assert_eq!(registry.superseded.len(),128);registry.replace([]).unwrap();assert!(registry.retirement(&old).is_err());
 }

}

/// A host engine bootstrap can retire old surfaces of its own window even
/// before a new service has a verified pin. It may never retire a new receiver.
pub fn engine_bootstrap_retires(window:&str,expected_epoch:&str,current_epoch:&str,view_window:&str,view_epoch:&str)->Result<bool,String>{
 if expected_epoch!=current_epoch{return Err("Engine bootstrap belongs to an old page".into());}
 if view_window!=window{return Ok(false);}
 if view_epoch==expected_epoch{return Err("Current-page native receiver already exists before engine bootstrap".into());}
 Ok(true)
}
#[cfg(test)]
mod engine_bootstrap_tests {
 use super::*;
 #[test]fn unpaired_bootstrap_retires_only_old_surfaces_in_its_trusted_window(){
  assert_eq!(engine_bootstrap_retires("own","new","new","own","old"),Ok(true));
  assert_eq!(engine_bootstrap_retires("own","new","new","other","old"),Ok(false));
  assert!(engine_bootstrap_retires("own","old","new","own","old").is_err());
  assert!(engine_bootstrap_retires("own","new","new","own","new").is_err());
 }
}
