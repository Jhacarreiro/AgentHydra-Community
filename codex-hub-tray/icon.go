package main

import (
	"bytes"
	"encoding/binary"
	"math"
)

type rgb struct{ r, g, b byte }

var (
	green = rgb{0x2d, 0xa4, 0x4e}
	amber = rgb{0xe0, 0x9b, 0x18}
	grey  = rgb{0x8a, 0x8a, 0x8a}
)

var icons = map[rgb][]byte{}

// icon draws the tray icon: a ring and a centre dot (a hub) in the status colour, as a 32x32 .ico.
func icon(c rgb) []byte {
	if b, ok := icons[c]; ok {
		return b
	}
	const n = 32
	px := make([]byte, 0, n*n*4)
	for y := n - 1; y >= 0; y-- { // bottom-up rows
		for x := 0; x < n; x++ {
			d := math.Hypot(float64(x)+0.5-n/2, float64(y)+0.5-n/2)
			// Coverage of the ring (radius 11.5-15) and the dot (radius 6), anti-aliased over one pixel.
			a := math.Max(clamp(15.5-d)*clamp(d-10.5), clamp(6.5-d))
			px = append(px, c.b, c.g, c.r, byte(a*255))
		}
	}
	var bmp bytes.Buffer
	binary.Write(&bmp, binary.LittleEndian, struct {
		Size                        uint32
		Width, Height               int32
		Planes, BitCount            uint16
		Compression, ImageSize      uint32
		XPels, YPels, Used, Importa int32
	}{40, n, 2 * n, 1, 32, 0, uint32(len(px) + n*4), 0, 0, 0, 0})
	bmp.Write(px)
	bmp.Write(make([]byte, n*4)) // AND mask, all zero: the alpha channel decides
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, 1})
	ico.Write([]byte{n, n, 0, 0})
	binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})
	binary.Write(&ico, binary.LittleEndian, []uint32{uint32(bmp.Len()), 22})
	ico.Write(bmp.Bytes())
	icons[c] = ico.Bytes()
	return icons[c]
}

func clamp(v float64) float64 { return math.Min(1, math.Max(0, v)) }
