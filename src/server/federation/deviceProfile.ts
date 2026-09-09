/** Client-reported display information; never used for authorization. */
export interface DeviceProfile {
  system?: string;
  client?: string;
  model?: string;
  arch?: string;
  cpu?: string;
  hostname?: string;
  mode?: string;
  route?: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
}
