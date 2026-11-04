"""Test-only PTY driver (Python standard library only; no pip, no runtime dependency).

Runs a command on a pseudo-terminal and speaks a line protocol on its own
stdio so a Node test can drive it:

  stdin  (commands, one per line)         stdout (events, JSON per line)
    send <hex>                              {"t": "out", "hex": "..."}
    resize <rows> <cols>                    {"t": "termios", "icanon": b, "echo": b, "isig": b}
    signal <NAME>                           {"t": "exit", "code": n | null, "signal": n | null}
    termios

Usage: python3 -I pty_driver.py ROWS COLS COMMAND [ARGS...]
The command inherits this process's environment.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    command = sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)
    set_size(master, rows, cols)
    deadline = time.monotonic() + 60
    stdin_open = True
    buffer = b""
    status = None
    while True:
        if time.monotonic() > deadline:
            os.kill(pid, signal.SIGKILL)
        readable = [master] + ([0] if stdin_open else [])
        ready, _, _ = select.select(readable, [], [], 0.05)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                emit({"t": "out", "hex": data.hex()})
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                stdin_open = False
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                parts = line.decode().split()
                if not parts:
                    continue
                if parts[0] == "send":
                    os.write(master, bytes.fromhex(parts[1]) if len(parts) > 1 else b"")
                elif parts[0] == "resize":
                    set_size(master, int(parts[1]), int(parts[2]))
                    os.kill(pid, signal.SIGWINCH)
                elif parts[0] == "signal":
                    os.kill(pid, getattr(signal, parts[1]))
                elif parts[0] == "termios":
                    attrs = termios.tcgetattr(master)
                    lflag = attrs[3]
                    emit({
                        "t": "termios",
                        "icanon": bool(lflag & termios.ICANON),
                        "echo": bool(lflag & termios.ECHO),
                        "isig": bool(lflag & termios.ISIG),
                    })
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            # Drain what the child wrote before it exited.
            try:
                while select.select([master], [], [], 0.05)[0]:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    emit({"t": "out", "hex": data.hex()})
            except OSError:
                pass
            break
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
    sig = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
    emit({"t": "exit", "code": code, "signal": sig})


main()
