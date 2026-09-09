// Termdock: every descriptor is owned until explicitly transferred to JS.
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master, pid_t* pid, int* err) {
  struct OwnedFd {
    int fd = -1;
    ~OwnedFd() { if (fd >= 0) close(fd); }
  } low_fds[3], parent_master, slave;
  *master = -1;
  *err = 0;
  for (size_t i = 0; i < 3; ++i) {
    low_fds[i].fd = posix_openpt(O_RDWR);
    if (low_fds[i].fd == -1) { *err = errno; return; }
    if (low_fds[i].fd >= STDERR_FILENO) break;
  }

  parent_master.fd = posix_openpt(O_RDWR);
  if (parent_master.fd == -1) { *err = errno; return; }
  if (grantpt(parent_master.fd) == -1 || unlockpt(parent_master.fd) == -1) {
    *err = errno; return;
  }
  char name[128];
  if (ioctl(parent_master.fd, TIOCPTYGNAME, name) == -1) { *err = errno; return; }
  slave.fd = open(name, O_RDWR | O_NOCTTY);
  if (slave.fd == -1) { *err = errno; return; }
  if (termp && tcsetattr(slave.fd, TCSANOW, termp) == -1) { *err = errno; return; }
  if (winp && ioctl(slave.fd, TIOCSWINSZ, winp) == -1) { *err = errno; return; }

  struct Actions {
    posix_spawn_file_actions_t value;
    bool initialized = false;
    ~Actions() { if (initialized) posix_spawn_file_actions_destroy(&value); }
  } acts;
  struct Attributes {
    posix_spawnattr_t value;
    bool initialized = false;
    ~Attributes() { if (initialized) posix_spawnattr_destroy(&value); }
  } attrs;
  if ((*err = posix_spawn_file_actions_init(&acts.value)) != 0) return;
  acts.initialized = true;
  for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; ++fd) {
    if ((*err = posix_spawn_file_actions_adddup2(&acts.value, slave.fd, fd)) != 0) return;
  }
  if ((*err = posix_spawn_file_actions_addclose(&acts.value, slave.fd)) != 0) return;
  if ((*err = posix_spawn_file_actions_addclose(&acts.value, parent_master.fd)) != 0) return;
  if ((*err = posix_spawnattr_init(&attrs.value)) != 0) return;
  attrs.initialized = true;
  const int flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF |
                    POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSID;
  if ((*err = posix_spawnattr_setflags(&attrs.value, flags)) != 0) return;
  sigset_t signals;
  sigfillset(&signals);
  if ((*err = posix_spawnattr_setsigdefault(&attrs.value, &signals)) != 0) return;
  sigemptyset(&signals);
  if ((*err = posix_spawnattr_setsigmask(&attrs.value, &signals)) != 0) return;
  do {
    *err = posix_spawn(pid, argv[0], &acts.value, &attrs.value, argv, env);
  } while (*err == EINTR);
  if (*err != 0) return;
  *master = parent_master.fd;
  parent_master.fd = -1; // JS owns only the master; parent closes slave and low FDs.
}
