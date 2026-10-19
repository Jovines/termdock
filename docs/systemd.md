# Running Termdock under systemd

When a systemd unit starts `td --supervise`, set `KillMode=process` if its
Termdock-managed tmux sessions and Agents must survive a Termdock service or
supervisor restart. systemd's default `KillMode=control-group` sends the stop
signal to the entire unit cgroup; that includes tmux servers and Agent
processes started by Termdock. It can therefore turn a service restart into a
simultaneous shutdown of every managed Agent.

The repository ships
[`10-preserve-tmux.conf`](../packaging/systemd/termdock.service.d/10-preserve-tmux.conf)
as a drop-in fragment. Install it under the drop-in directory for the unit
that runs Termdock (the example path assumes `termdock.service`):

```sh
sudo install -D -m 0644 packaging/systemd/termdock.service.d/10-preserve-tmux.conf \
  /etc/systemd/system/termdock.service.d/10-preserve-tmux.conf
sudo systemctl daemon-reload
systemctl show termdock.service -p KillMode
```

The final command should report `KillMode=process`. If the unit has a different
name, use its matching `/etc/systemd/system/<unit>.service.d/` directory and
verify that unit.

This setting intentionally leaves tmux workloads alive when systemd stops the
Termdock main process. Before permanently removing the service or host, close
or release managed sessions through Termdock's session lifecycle and verify
that the runtime inventory is empty. Do not use `systemctl kill` or restore
`KillMode=control-group` as a way to clean up Agent sessions; those actions can
terminate unrelated work in the unit.

This is a process-manager boundary, separate from recovery queue admission.
Termdock will not terminate non-Termdock processes to satisfy its memory or
resident-Agent budget.
