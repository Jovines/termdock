// Fault-inject every syscall in the actual shipped macOS spawn replacement.
// Portable harness: validates ownership, not macOS kernel behavior.
#include <cassert>
#include <cerrno>
#include <cstddef>
#include <set>
#include <cstdio>
struct termios {};
struct winsize {};
using posix_spawn_file_actions_t = int;
using posix_spawnattr_t = int;
using pid_t = int;
#define sigset_t TestSigSet
using TestSigSet = int;
constexpr int STDIN_FILENO=0, STDOUT_FILENO=1, STDERR_FILENO=2;
constexpr int O_RDWR=1, O_NOCTTY=2, TCSANOW=0, TIOCPTYGNAME=1, TIOCSWINSZ=2;
constexpr int POSIX_SPAWN_CLOEXEC_DEFAULT=1, POSIX_SPAWN_SETSIGDEF=2,
              POSIX_SPAWN_SETSIGMASK=4, POSIX_SPAWN_SETSID=8;
static std::set<int> fds;
static int step, failAt, actions, attrs;
static bool interrupted;
int operation() { ++step; if (step == failAt) { errno=EMFILE; return -1; } return 0; }
int action() { return operation() == -1 ? ENOMEM : 0; }
int allocate() {
  if (operation() == -1) return -1;
  int fd=0; while (fds.count(fd)) ++fd;
  fds.insert(fd); return fd;
}
int posix_openpt(int) { return allocate(); }
int open(const char*, int) { return allocate(); }
int close(int fd) { assert(fds.erase(fd) == 1); return 0; }
int grantpt(int) { return operation(); }
int unlockpt(int) { return operation(); }
int ioctl(int, int, const void*) { return operation(); }
int tcsetattr(int, int, const termios*) { return operation(); }
int posix_spawn_file_actions_init(int*) { int r=action(); if (!r) ++actions; return r; }
int posix_spawn_file_actions_destroy(int*) { --actions; return 0; }
int posix_spawn_file_actions_adddup2(int*, int, int) { return action(); }
int posix_spawn_file_actions_addclose(int*, int) { return action(); }
int posix_spawnattr_init(int*) { int r=action(); if (!r) ++attrs; return r; }
int posix_spawnattr_destroy(int*) { --attrs; return 0; }
int posix_spawnattr_setflags(int*, int) { return action(); }
int posix_spawnattr_setsigdefault(int*, int*) { return action(); }
int posix_spawnattr_setsigmask(int*, int*) { return action(); }
int sigfillset(int*) { return 0; }
int sigemptyset(int*) { return 0; }
int posix_spawn(pid_t* pid, char*, int*, int*, char**, char**) {
  if (interrupted) { interrupted=false; return EINTR; }
  *pid=42; return action();
}
#include "node-pty-darwin-spawn.inc"
int main() {
  termios term; winsize win;
  char executable[]="helper"; char* argv[]={executable, nullptr};
  int cases=0;
  for (int mask=0; mask<8; ++mask) {
    int stages=0;
    for (int failure=0; failure<=stages; ++failure) {
      fds.clear();
      for (int fd=0; fd<3; ++fd) if (mask & (1<<fd)) fds.insert(fd);
      const auto baseline=fds;
      step=0; failAt=failure; actions=attrs=0; interrupted=true;
      int master=-9, pid=-9, err=-9;
      pty_posix_spawn(argv, argv, &term, &win, &master, &pid, &err);
      if (!failure) {
        stages=step;
        assert(err == 0 && master >= 3 && pid == 42);
        assert(fds.size() == baseline.size()+1);
        close(master);
      } else {
        assert((err == EMFILE || err == ENOMEM) && master == -1);
      }
      assert(fds == baseline);
      assert(actions == 0 && attrs == 0);
      ++cases;
    }
  }
  printf("%d cleanup cases passed\n", cases);
}
