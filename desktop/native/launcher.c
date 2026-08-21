#include <mach-o/dyld.h>
#include <arpa/inet.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static pid_t electron_pid = -1;

static void forward_signal(int signal_number) {
  if (electron_pid > 0) {
    kill(electron_pid, signal_number);
  }
}

static void trigger_local_network_permission(void) {
  const int socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (socket_fd < 0) return;

  struct sockaddr_in destination = {0};
  destination.sin_family = AF_INET;
  destination.sin_port = htons(5353);
  if (inet_pton(AF_INET, "224.0.0.251", &destination.sin_addr) == 1) {
    static const char probe[] = "Termdock";
    (void)sendto(
      socket_fd,
      probe,
      sizeof(probe) - 1,
      0,
      (const struct sockaddr *)&destination,
      sizeof(destination)
    );
  }
  close(socket_fd);
}

int main(int argc, char *argv[]) {
  (void)argc;
  char launcher_path[PATH_MAX];
  uint32_t launcher_path_size = sizeof(launcher_path);
  if (_NSGetExecutablePath(launcher_path, &launcher_path_size) != 0) {
    fputs("Termdock launcher could not resolve its executable path.\n", stderr);
    return 1;
  }

  char electron_path[PATH_MAX];
  const int written = snprintf(electron_path, sizeof(electron_path), "%s.electron", launcher_path);
  if (written < 0 || (size_t)written >= sizeof(electron_path)) {
    fputs("Termdock launcher executable path is too long.\n", stderr);
    return 1;
  }

  trigger_local_network_permission();

  argv[0] = electron_path;
  const int spawn_result = posix_spawn(&electron_pid, electron_path, NULL, NULL, argv, environ);
  if (spawn_result != 0) {
    errno = spawn_result;
    perror("Termdock launcher could not start Electron");
    return 1;
  }

  signal(SIGTERM, forward_signal);
  signal(SIGINT, forward_signal);
  signal(SIGHUP, forward_signal);

  int child_status = 0;
  while (waitpid(electron_pid, &child_status, 0) < 0) {
    if (errno != EINTR) {
      perror("Termdock launcher could not wait for Electron");
      return 1;
    }
  }
  if (WIFEXITED(child_status)) return WEXITSTATUS(child_status);
  if (WIFSIGNALED(child_status)) return 128 + WTERMSIG(child_status);
  return 1;
}
