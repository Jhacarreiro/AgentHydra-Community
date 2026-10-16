// Command sniwatcher stands in for a desktop's tray host in test-linux.sh: it owns org.kde.StatusNotifierWatcher on
// the session bus and, for each item that registers and each new icon it announces, prints the icon it shows:
//
//	sniwatcher: item :1.4 icon 32x32 visible 688 title "Codex Hub"
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
)

type watcher struct{ conn *dbus.Conn }

func (w watcher) RegisterStatusNotifierItem(path string, sender dbus.Sender) *dbus.Error {
	go func() {
		time.Sleep(500 * time.Millisecond) // the item sets its properties right after registering
		w.show(string(sender), dbus.ObjectPath(path))
	}()
	return nil
}

func (w watcher) show(sender string, path dbus.ObjectPath) {
	obj := w.conn.Object(sender, path)
	v, err := obj.GetProperty("org.kde.StatusNotifierItem.IconPixmap")
	if err != nil {
		fmt.Println("sniwatcher: IconPixmap:", err)
		return
	}
	var px []struct {
		W, H int32
		Pix  []byte
	}
	if err := dbus.Store([]any{v.Value()}, &px); err != nil || len(px) == 0 {
		fmt.Printf("sniwatcher: item %s icon none (%v)\n", sender, err)
		return
	}
	visible := 0
	for i := 0; i+3 < len(px[0].Pix); i += 4 {
		if px[0].Pix[i] != 0 { // ARGB: the alpha byte comes first
			visible++
		}
	}
	title, _ := obj.GetProperty("org.kde.StatusNotifierItem.Title")
	fmt.Printf("sniwatcher: item %s icon %dx%d visible %d title %v\n", sender, px[0].W, px[0].H, visible, title)
}

func main() {
	conn, err := dbus.SessionBus()
	if err != nil {
		fmt.Println("sniwatcher:", err)
		os.Exit(1)
	}
	conn.Export(watcher{conn}, "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher")
	if r, err := conn.RequestName("org.kde.StatusNotifierWatcher", dbus.NameFlagDoNotQueue); err != nil || r != dbus.RequestNameReplyPrimaryOwner {
		fmt.Println("sniwatcher: could not own the watcher name:", r, err)
		os.Exit(1)
	}
	conn.AddMatchSignal(dbus.WithMatchInterface("org.kde.StatusNotifierItem"), dbus.WithMatchMember("NewIcon"))
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	fmt.Println("sniwatcher: ready")
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	for {
		select {
		case s := <-signals:
			if s != nil && s.Name == "org.kde.StatusNotifierItem.NewIcon" {
				go watcher{conn}.show(s.Sender, s.Path)
			}
		case <-stop:
			return
		}
	}
}
