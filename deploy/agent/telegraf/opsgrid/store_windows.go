//go:build windows

package opsgrid

import (
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const defaultStateDir = `C:\ProgramData\OpsGrid`
const protectedSDDL = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
const trustedInstallerSID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"

func trustedSID(sid *windows.SID, ancestor bool) bool {
	if sid == nil {
		return false
	}
	text := sid.String()
	return text == "S-1-5-18" || text == "S-1-5-32-544" || (ancestor && text == trustedInstallerSID)
}
func platformValidate(path string, info os.FileInfo, directory, ancestor bool) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return failure("UNSAFE_STATE_REPARSE_POINT")
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return failure("UNSAFE_STATE_PATH")
	}
	// OPEN_REPARSE_POINT examines the object rather than following a junction.
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return failure("STATE_SECURITY_CHECK_FAILED")
	}
	defer windows.CloseHandle(handle)
	var fileInfo windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &fileInfo) != nil || fileInfo.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return failure("UNSAFE_STATE_REPARSE_POINT")
	}
	if !directory && fileInfo.NumberOfLinks != 1 {
		return failure("UNSAFE_STATE_FILE")
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || descriptor == nil {
		return failure("STATE_SECURITY_CHECK_FAILED")
	}
	owner, _, err := descriptor.Owner()
	if err != nil || !trustedSID(owner, ancestor) {
		return failure("UNSAFE_STATE_OWNER")
	}
	control, _, err := descriptor.Control()
	if err != nil || (!ancestor && control&windows.SE_DACL_PROTECTED == 0) {
		return failure("UNSAFE_STATE_PERMISSIONS")
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return failure("UNSAFE_STATE_PERMISSIONS")
	}
	allowed := false
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return failure("STATE_SECURITY_CHECK_FAILED")
		}
		if ace.Header.AceFlags&0x08 != 0 {
			continue
		} // INHERIT_ONLY_ACE does not apply here.
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return failure("UNSAFE_STATE_PERMISSIONS")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if trustedSID(sid, ancestor) {
			allowed = true
			continue
		}
		if !ancestor {
			return failure("UNSAFE_STATE_PERMISSIONS")
		}
		// Standard ProgramData may grant additive creation and directory attributes
		// to Users. Neither right replaces an existing protected child. Reject
		// deletion/namespace replacement and security/ownership changes. StateDir
		// itself remains protected, SYSTEM/Admin-only, non-reparse and nonempty.
		const unsafeParentRights = windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_ALL | 0x40 // FILE_DELETE_CHILD
		if uint32(ace.Mask)&uint32(unsafeParentRights) != 0 {
			return failure("UNSAFE_STATE_PARENT")
		}
	}
	runtime.KeepAlive(descriptor)
	if !allowed {
		return failure("UNSAFE_STATE_PERMISSIONS")
	}
	return nil
}
func platformLock(file *os.File) error {
	overlapped := &windows.Overlapped{}
	if windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped) != nil {
		return failure("MANAGED_RUNTIME_ACTIVE")
	}
	return nil
}

func protectedDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	descriptor, err := windows.SecurityDescriptorFromString(protectedSDDL)
	if err != nil {
		return nil, failure("STATE_PROTECTION_FAILED")
	}
	return descriptor, nil
}
func platformCreateDirectory(path string) error {
	descriptor, err := protectedDescriptor()
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	err = windows.CreateDirectory(name, &attributes)
	runtime.KeepAlive(descriptor)
	return err
}
func platformProtectFile(path string) error {
	descriptor, err := protectedDescriptor()
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	// Temp is born inside an already-restricted inheriting directory; explicitly
	// protect its DACL before any credential/config bytes are written. No chmod.
	err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, nil, acl, nil)
	runtime.KeepAlive(descriptor)
	if err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return failure("STATE_PROTECTION_FAILED")
	}
	return platformValidate(path, info, false, false)
}
func platformReplace(source, target string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func platformSyncDirectory(_ string) error {
	// File.Sync flushes content before replacement; MoveFileEx WRITE_THROUGH is the
	// Windows rename durability primitive. Unix directory fsync is not emulated.
	return nil
}
