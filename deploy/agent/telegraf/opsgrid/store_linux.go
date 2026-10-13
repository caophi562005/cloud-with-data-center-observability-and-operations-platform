//go:build linux

package opsgrid

import (
	"os"
	"syscall"
)

const defaultStateDir = "/etc/opsgrid-agent"

// Strict root-only default until Task 7 explicitly chooses the runtime identity.
// This is not a claim of compatibility with an arbitrary non-root service user.
func platformValidate(_ string, info os.FileInfo, directory, ancestor bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || info.Mode()&os.ModeSymlink != 0 {
		return failure("UNSAFE_STATE_OWNER")
	}
	if directory {
		if !info.IsDir() {
			return failure("UNSAFE_STATE_DIRECTORY")
		}
		if ancestor {
			if info.Mode().Perm()&0022 != 0 {
				return failure("UNSAFE_STATE_PARENT")
			}
		} else if info.Mode().Perm() != 0700 {
			return failure("UNSAFE_STATE_PERMISSIONS")
		}
	} else if !info.Mode().IsRegular() || stat.Nlink != 1 || info.Mode().Perm() != 0600 {
		return failure("UNSAFE_STATE_PERMISSIONS")
	}
	return nil
}
func platformLock(file *os.File) error {
	if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return failure("MANAGED_RUNTIME_ACTIVE")
	}
	return nil
}

func platformCreateDirectory(path string) error { return os.Mkdir(path, 0700) }
func platformProtectFile(path string) error {
	if err := os.Chmod(path, 0600); err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	return platformValidate(path, info, false, false)
}
func platformReplace(source, target string) error { return os.Rename(source, target) }
func platformSyncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return failure("STATE_SYNC_FAILED")
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return failure("STATE_SYNC_FAILED")
	}
	return nil
}
