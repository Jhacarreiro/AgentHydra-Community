//go:build linux || darwin

package main

// The macOS app bundle the tray installs as. Nothing here needs macOS, so it builds on Linux too and its tests
// run there.

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// placeBundle installs the bundle that holds the program from (or, for a bare build, a bundle made around it) at
// dst, replacing the one there only once the copy is whole.
func placeBundle(from, dst string) error {
	parent := filepath.Dir(dst)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(parent, "."+filepath.Base(dst)+".new")
	old := filepath.Join(parent, "."+filepath.Base(dst)+".old")
	os.RemoveAll(tmp)
	os.RemoveAll(old)
	var err error
	if src := bundleOf(from); src != "" {
		err = copyTree(src, tmp)
	} else {
		err = makeBundle(from, tmp)
	}
	if err != nil {
		os.RemoveAll(tmp)
		return err
	}
	if exists(dst) {
		if err := os.Rename(dst, old); err != nil {
			os.RemoveAll(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Rename(old, dst)
		return err
	}
	os.RemoveAll(old)
	return nil
}

// bundleOf is the .app that has exe as its program (X.app/Contents/MacOS/exe), or "" when exe is not in one.
func bundleOf(exe string) string {
	macos := filepath.Dir(resolved(exe))
	contents := filepath.Dir(macos)
	app := filepath.Dir(contents)
	if filepath.Base(macos) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(app, ".app") {
		return app
	}
	return ""
}

// makeBundle makes an app bundle at dst around the program exe.
func makeBundle(exe, dst string) error {
	dir := filepath.Join(dst, "Contents", "MacOS")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dst, "Contents", "Info.plist"), []byte(infoPlist(bundleID)), 0o644); err != nil {
		return err
	}
	return copyFile(exe, filepath.Join(dir, "codex-hub-tray"))
}

// copyTree copies a folder, keeping each file's mode and the symlinks as they are.
func copyTree(src, dst string) error {
	src = resolved(src)
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, to)
		case info.IsDir():
			if err := os.MkdirAll(to, 0o700); err != nil {
				return err
			}
			return os.Chmod(to, info.Mode().Perm()|0o700) // the copy's owner can fill it and replace it
		default:
			return copyWithMode(p, to, info.Mode().Perm())
		}
	})
}

func copyWithMode(from, to string, mode fs.FileMode) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(mode); err != nil { // past the umask
		out.Close()
		return err
	}
	return out.Close()
}
