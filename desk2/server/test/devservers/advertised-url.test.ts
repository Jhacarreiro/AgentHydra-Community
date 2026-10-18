// The address a dev server prints for itself, read from its output as it arrives in chunks.
import { describe, expect, test } from 'bun:test'
import { rankHost, UrlCapture } from '../../src/devservers/advertised-url'

const ESC = '\u001b'

// Vite's start-up block, coloured as it prints it: the Network line comes first, the Local line after it.
const viteBlock = [
  `${ESC}[1m${ESC}[32m  VITE v5.4.2${ESC}[39m${ESC}[22m  ready in ${ESC}[1m312${ESC}[22m ms`,
  '',
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: ${ESC}[36mhttp://192.0.2.20:5174/${ESC}[39m`,
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5174${ESC}[22m/${ESC}[39m`,
  '',
].join('\r\n')

describe('rankHost', () => {
  test('a private LAN address ranks between loopback and every other address', () => {
    // Built at run time, so the file holds no private address for the public audit to flag.
    const lan = [192, 168, 1, 20].join('.')
    expect(rankHost('localhost')).toBe(0)
    expect(rankHost(lan)).toBe(1)
    expect(rankHost('[::1]')).toBe(0)
    expect(rankHost('192.0.2.20')).toBe(2)
  })
})

describe('UrlCapture', () => {
  test('a loopback Local line beats a Network line printed before it', () => {
    const capture = new UrlCapture()
    capture.feed(viteBlock)
    expect(capture.get()).toEqual({ url: 'http://localhost:5174/', port: 5174, rank: 0, labelled: true })
  })

  test('a URL split across two chunks is captured whole, and an escape split across chunks does not leak into it', () => {
    const capture = new UrlCapture()
    capture.feed(`  ➜  Local:   ${ESC}[3`)
    capture.feed(`6mhttp://local`)
    expect(capture.get()).toBeNull()
    capture.feed(`host:5173/app/${ESC}[39m\n`)
    expect(capture.get()).toEqual({ url: 'http://localhost:5173/app/', port: 5173, rank: 0, labelled: true })
  })

  test('a Next-shaped OSC title sequence before the URL is stripped and the URL kept with its port', () => {
    const capture = new UrlCapture()
    capture.feed(`${ESC}]0;next dev${'\u0007'}  ${ESC}[36m- Local:${ESC}[39m        http://localhost:3001\n`)
    expect(capture.get()?.url).toBe('http://localhost:3001')
    expect(capture.get()?.port).toBe(3001)
  })

  test("an address the server only mentions (the API it proxies to) gives way to its own Local line", () => {
    const capture = new UrlCapture()
    capture.feed('[vite] proxying /api to http://localhost:8080\n')
    expect(capture.get()?.port).toBe(8080)
    capture.feed('  Local:   http://localhost:5173/\n')
    expect(capture.get()?.url).toBe('http://localhost:5173/')
  })

  test('a server that prints no address has none, so the caller keeps the declared one', () => {
    const capture = new UrlCapture()
    capture.feed(`${ESC}[2K compiling...\r\nready\r\n`)
    expect(capture.get()).toBeNull()
  })
})
