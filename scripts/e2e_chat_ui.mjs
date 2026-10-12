// Kiểm tra giao diện chat trên trình duyệt thật (Playwright/Chromium) qua toàn bộ stack Docker.
//
// CHỈ DÙNG TRÊN STACK THỬ NGHIỆM: script tạo người dùng, nhóm, đổi mật khẩu admin và khoá một tài khoản.
//
// Playwright được cài NGOÀI repo (ví dụ một thư mục tạm):
//   mkdir <dir> && cd <dir> && npm init -y && npm i playwright@1.49.1 && npx playwright install chromium
// Chạy (từ thư mục gốc repo, Node 22+):
//   PLAYWRIGHT_DIR=<dir> BASE_URL=http://localhost ADMIN_USER=ui.admin ADMIN_TEMP_PASSWORD=<mật khẩu tạm> \
//     node scripts/e2e_chat_ui.mjs
// Tuỳ chọn: E2E_ADMIN_NEW_PASSWORD=<mật khẩu mới của admin> (mặc định sinh ngẫu nhiên và in ra một lần; chạy lại trên cùng stack BẮT BUỘC đặt đúng giá trị đã in),
//           SHOT_DIR=<thư mục> (nơi lưu ảnh chụp khi một bước hỏng, mặc định thư mục tạm của hệ điều hành),
//           HEADED=1 (mở cửa sổ trình duyệt).
// In PASS/FAIL cho từng bước, cuối cùng in "N/M đạt" và thoát mã 1 nếu có bước hỏng.
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { PLAYWRIGHT_DIR, ADMIN_USER, ADMIN_TEMP_PASSWORD } = process.env
if (!PLAYWRIGHT_DIR || !ADMIN_USER || !ADMIN_TEMP_PASSWORD) {
  console.error('Cần PLAYWRIGHT_DIR, ADMIN_USER, ADMIN_TEMP_PASSWORD (và BASE_URL nếu không phải http://localhost).')
  process.exit(2)
}
const BASE = (process.env.BASE_URL ?? 'http://localhost').replace(/\/$/, '')
const SHOT_DIR = process.env.SHOT_DIR ?? os.tmpdir()
// Script này tạo người dùng/nhóm, đổi mật khẩu admin và khoá tài khoản: chỉ chạy trên stack thử nghiệm.
// Mật khẩu trong script chỉ là giá trị dùng một lần cho stack thử nghiệm.
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.E2E_ALLOW_REMOTE !== '1') {
  console.error(`Từ chối chạy với BASE_URL=${BASE}: chỉ localhost/127.0.0.1. Đặt E2E_ALLOW_REMOTE=1 nếu chắc chắn đó là stack thử nghiệm.`)
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs')).href)

// Mật khẩu mới của admin: lấy từ E2E_ADMIN_NEW_PASSWORD hoặc sinh ngẫu nhiên (in ra một lần để chạy lại).
const ADMIN_PW = process.env.E2E_ADMIN_NEW_PASSWORD || `Ui-${randomBytes(9).toString('base64url')}-9a!`
if (!process.env.E2E_ADMIN_NEW_PASSWORD) console.log(`Mật khẩu admin mới cho lần chạy này: ${ADMIN_PW} (đặt E2E_ADMIN_NEW_PASSWORD để chạy lại)`)
const ALICE_PW = 'UiAlicePassw0rd!'
const BOB_PW = 'UiBobPassw0rd!'
const TAG = Date.now().toString(36).slice(-6)
const ALICE = { username: `ui.alice.${TAG}`, fullName: `Lê Thu Hà ${TAG}` }
const BOB = { username: `ui.bob.${TAG}`, fullName: `Trần Quốc Huy ${TAG}` }
const CAROL = { username: `ui.carol.${TAG}`, fullName: `Bot Gửi Tin ${TAG}` }
const GROUP = `UI nhóm ${TAG}`
const GROUP2 = `UI nhóm 2 ${TAG}`

// ---------------- REST ----------------

async function http(method, urlPath, token, body) {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function must(method, urlPath, token, body, expected = [200, 201, 204]) {
  const r = await http(method, urlPath, token, body)
  if (!expected.includes(r.status)) throw new Error(`${method} ${urlPath} -> ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

/** Đăng nhập qua REST; nếu buộc đổi mật khẩu thì đổi sang newPw. Trả access token. */
async function restReady(username, password, newPw) {
  let r = await http('POST', '/auth/login', null, { username, password })
  if (r.status === 401 && newPw) r = await http('POST', '/auth/login', null, { username, password: newPw }) // chạy lại
  if (r.status !== 200) throw new Error(`login ${username} -> ${r.status} ${JSON.stringify(r.data)}`)
  let token = r.data.access_token
  if (r.data.must_change_password) {
    token = (await must('POST', '/auth/change-password', token, { current_password: password, new_password: newPw })).access_token
  }
  return token
}

// ---------------- WebSocket (người gửi phụ, không qua giao diện) ----------------

const WS_BURST = 20 // máy chủ giới hạn 20 tin / 10 giây cho mỗi kết nối

async function openBot(token) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/ws')
  const waiters = new Map()
  let readyResolve
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    setTimeout(() => reject(new Error('bot: không nhận được ready')), 10000)
  })
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)
    if (data.type === 'ready') readyResolve()
    const cid = data.message?.client_id ?? data.client_id
    if (cid && waiters.has(cid)) {
      waiters.get(cid)(data)
      waiters.delete(cid)
    }
  }
  await ready
  let n = 0
  return {
    send(roomId, body) {
      const clientId = `bot-${TAG}-${Date.now()}-${n++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bot: gửi quá hạn')), 10000)
        waiters.set(clientId, (data) => {
          clearTimeout(timer)
          if (data.type !== 'message') reject(new Error('bot: lỗi ' + JSON.stringify(data)))
          else resolve(data.message)
        })
        ws.send(JSON.stringify({ type: 'send', room_id: roomId, body, client_id: clientId }))
      })
    },
    close: () => ws.close(),
  }
}

/** Gửi tuần tự (giữ thứ tự), mở kết nối mới sau mỗi WS_BURST tin để không chạm giới hạn tốc độ. */
async function botSendMany(token, roomId, bodies) {
  let bot = null
  try {
    for (let i = 0; i < bodies.length; i++) {
      if (i % WS_BURST === 0) {
        bot?.close()
        bot = await openBot(token)
      }
      await bot.send(roomId, bodies[i])
    }
  } finally {
    bot?.close()
  }
}

// ---------------- tiện ích ----------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(fn, timeout, what) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) throw new Error(`hết ${timeout}ms chờ: ${what}${last instanceof Error ? ' (' + last.message.split('\n')[0] + ')' : ''}`)
    await sleep(150)
  }
}

const results = []
const pages = {} // tên -> page, để chụp ảnh khi hỏng

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}${detail ? '  -> ' + detail : ''}  (${Date.now() - started}ms)`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}  -> ${String(err?.message ?? err).split('\n')[0]}`)
    const n = results.length
    for (const [who, page] of Object.entries(pages)) {
      if (!page.isClosed()) await page.screenshot({ path: path.join(SHOT_DIR, `fail-${n}-${who}.png`) }).catch(() => {})
    }
  }
}

async function loginAndChangePassword(page, username, tempPw, newPw) {
  await page.goto(BASE + '/login')
  await page.getByLabel('Tên đăng nhập').fill(username)
  await page.getByLabel('Mật khẩu', { exact: true }).fill(tempPw)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await page.getByRole('heading', { name: 'Đổi mật khẩu' }).waitFor({ timeout: 10000 })
  await page.getByLabel('Mật khẩu hiện tại').fill(tempPw)
  await page.getByLabel('Mật khẩu mới', { exact: true }).fill(newPw)
  await page.getByLabel('Nhập lại mật khẩu mới').fill(newPw)
  await page.getByRole('button', { name: 'Lưu mật khẩu mới' }).click()
}

async function login(page, username, password) {
  await page.goto(BASE + '/login')
  await page.getByLabel('Tên đăng nhập').fill(username)
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
}

const sidebar = (page) => page.locator('.chat-side')
const roomItem = (page, name) => page.locator('.chat-side .room-item').filter({ has: page.locator('strong', { hasText: new RegExp(`^${escapeRe(name)}$`) }) })
const msgList = (page) => page.getByTestId('message-list')
const bubbles = (page, text) => msgList(page).locator('.msg', { hasText: text })
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function openRoom(page, name) {
  await roomItem(page, name).click()
  await page.locator('.chat-head h2', { hasText: new RegExp(`^${escapeRe(name)}$`) }).waitFor({ timeout: 10000 })
  await waitUntil(async () => (await msgList(page).locator('.msg-note', { hasText: 'Đang tải…' }).count()) === 0, 10000, 'tải xong tin')
}

async function send(page, text) {
  const box = page.getByLabel('Nhập tin nhắn')
  await box.fill(text)
  await box.press('Enter')
}

/** Đếm số bong bóng chứa đúng văn bản, chờ thêm một nhịp để bắt được tin trùng tới muộn. */
async function expectExactlyOnce(page, text, timeout, what) {
  await waitUntil(async () => (await bubbles(page, text).count()) >= 1, timeout, what)
  await sleep(1500)
  const n = await bubbles(page, text).count()
  if (n !== 1) throw new Error(`${what}: ${n} bong bóng (mong đợi 1)`)
}

/** Số đo cuộn của danh sách tin. gap = khoảng cách tới đáy. */
const scrollMetrics = (page) =>
  msgList(page).evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight }))

/**
 * Bong bóng của tin thật đầu tiên đang nhìn thấy và khoảng cách từ mép trên danh sách tới nó.
 * Đo bong bóng (không đo cả khối .msg): khi tin cũ cùng người gửi được thêm lên trên, dòng tên người
 * gửi phía trên bong bóng biến mất một cách hợp lệ, nhưng nội dung người dùng đang đọc không được nhảy.
 */
const firstVisible = (page) =>
  msgList(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const msgs = [...el.querySelectorAll('.msg[data-message-id]')].filter((m) => Number(m.dataset.messageId) > 0)
    const first = msgs.find((m) => m.querySelector('.bubble').getBoundingClientRect().bottom > top + 1)
    return first ? { id: first.dataset.messageId, offset: first.querySelector('.bubble').getBoundingClientRect().top - top } : null
  })

const offsetOf = (page, id) =>
  msgList(page).evaluate((el, mid) => {
    const b = el.querySelector(`.msg[data-message-id="${mid}"] .bubble`)
    return b ? b.getBoundingClientRect().top - el.getBoundingClientRect().top : null
  }, id)

/** Chờ cuộn ổn định (ResizeObserver/ảnh/phông): hai lần đo liên tiếp giống nhau. */
async function settle(page) {
  let prev = null
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const m = await scrollMetrics(page)
    if (prev && prev.top === m.top && prev.height === m.height) return m
    prev = m
    await sleep(100)
  }
  return prev
}

// ---------------- chuẩn bị dữ liệu (REST) ----------------

console.log(`Chạy với BASE_URL=${BASE}, thẻ ${TAG}`)
const adminToken = await restReady(ADMIN_USER, ADMIN_TEMP_PASSWORD, ADMIN_PW)
const branches = await must('GET', '/admin/branches', adminToken)
if (!branches.length) throw new Error('chưa có chi nhánh nào')
const branchId = branches[0].id
const created = {}
for (const u of [ALICE, BOB, CAROL]) {
  created[u.username] = await must('POST', '/admin/users', adminToken, { username: u.username, full_name: u.fullName, branch_id: branchId, role: 'member' })
}
const aliceId = created[ALICE.username].id
const bobId = created[BOB.username].id
const carolId = created[CAROL.username].id
const group = await must('POST', '/admin/rooms', adminToken, { name: GROUP, branch_id: branchId, member_ids: [aliceId, bobId, carolId] })
const carolToken = await restReady(CAROL.username, created[CAROL.username].temp_password, 'UiCarolPassw0rd!')

// ---------------- trình duyệt ----------------

const browser = await chromium.launch({ headless: !process.env.HEADED })
const desktop = { viewport: { width: 1280, height: 800 }, locale: 'vi-VN' }
const aliceCtx = await browser.newContext(desktop)
const bobCtx = await browser.newContext(desktop)
const sockets = { alice: [], bob: [] }

/**
 * Mất mạng thật cho cả WebSocket. `context.setOffline` của Chromium chỉ chặn HTTP: WebSocket đang mở
 * vẫn sống và kết nối mới vẫn được phép. Vì vậy WebSocket của Alice/Bob đi qua `routeWebSocket` (proxy
 * trong suốt tới máy chủ); khi "mất mạng" thì cắt mọi kết nối đang mở và đóng ngay mọi kết nối mới.
 */
async function networkSwitch(ctx, who) {
  const state = { offline: false, live: new Set() }
  await ctx.routeWebSocket(/\/api\/ws$/, (ws) => {
    sockets[who].push({ url: ws.url(), at: Date.now() })
    if (state.offline) {
      ws.onMessage(() => {}) // không có máy chủ: nuốt khung auth
      setTimeout(() => void ws.close({ code: 1001, reason: 'offline' }), 50)
      return
    }
    const server = ws.connectToServer()
    const link = { ws, server }
    state.live.add(link)
    ws.onClose((code, reason) => {
      state.live.delete(link)
      void server.close({ code, reason })
    })
    server.onClose((code, reason) => {
      state.live.delete(link)
      void ws.close({ code, reason })
    })
  })
  return async (offline) => {
    state.offline = offline
    await ctx.setOffline(offline)
    if (offline) {
      for (const link of [...state.live]) {
        state.live.delete(link)
        await link.server.close({ code: 1001, reason: 'client offline' })
        await link.ws.close({ code: 1001, reason: 'offline' })
      }
    }
  }
}
const setAliceOffline = await networkSwitch(aliceCtx, 'alice')
const setBobOffline = await networkSwitch(bobCtx, 'bob')
const alice = await aliceCtx.newPage()
const bob = await bobCtx.newPage()
pages.alice = alice
pages.bob = bob

const pageErrors = []
const unexpectedDialogs = []
const aliceRequests = []
function watch(page, who) {
  page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`))
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm' && dialog.message().startsWith('Xoá tin nhắn')) await dialog.accept()
    else {
      unexpectedDialogs.push(`${who}: ${dialog.type()} ${dialog.message()}`)
      await dialog.dismiss()
    }
  })
}
watch(alice, 'alice')
watch(bob, 'bob')
alice.on('request', (req) => aliceRequests.push(req.url()))

let directName = ''

await step('1. Alice và Bob đăng nhập, đổi mật khẩu, thấy "UI nhóm" ở thanh bên', async () => {
  await loginAndChangePassword(alice, ALICE.username, created[ALICE.username].temp_password, ALICE_PW)
  await loginAndChangePassword(bob, BOB.username, created[BOB.username].temp_password, BOB_PW)
  for (const [page, u] of [[alice, ALICE], [bob, BOB]]) {
    await page.getByText(`Xin chào, ${u.fullName}`).waitFor({ timeout: 10000 })
    await roomItem(page, GROUP).waitFor({ timeout: 10000 })
  }
})

await step('2. Alice gửi "xin chào cả nhóm": hiện ngay với "Đang gửi…" rồi trạng thái biến mất', async () => {
  await openRoom(alice, GROUP)
  await waitUntil(() => alice.evaluate(() => document.querySelector('.conn-banner') === null), 10000, 'WebSocket của Alice mở')
  await alice.evaluate(() => {
    window.__sawSending = false
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="message-list"]')?.textContent?.includes('Đang gửi…')) window.__sawSending = true
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  const t0 = Date.now()
  await send(alice, 'xin chào cả nhóm')
  await bubbles(alice, 'xin chào cả nhóm').waitFor({ timeout: 2000 })
  const shownMs = Date.now() - t0
  await waitUntil(async () => Number(await bubbles(alice, 'xin chào cả nhóm').getAttribute('data-message-id')) > 0, 10000, 'tin được xác nhận')
  const sending = await bubbles(alice, 'xin chào cả nhóm').getByText('Đang gửi…').count()
  if (sending) throw new Error('vẫn còn "Đang gửi…"')
  if (!(await alice.evaluate(() => window.__sawSending))) throw new Error('không thấy trạng thái "Đang gửi…" lúc nào')
  if ((await bubbles(alice, 'xin chào cả nhóm').count()) !== 1) throw new Error('bong bóng bị trùng')
  return `hiện sau ${shownMs}ms`
})

await step('3. Bob (ở danh sách) thấy huy hiệu 1 không cần tải lại; mở phòng thì thấy tin, huy hiệu mất', async () => {
  const badge = roomItem(bob, GROUP).locator('.unread-badge')
  await waitUntil(async () => (await badge.count()) === 1 && (await badge.innerText()).trim() === '1', 10000, 'huy hiệu "1"')
  await openRoom(bob, GROUP)
  await bubbles(bob, 'xin chào cả nhóm').waitFor({ timeout: 5000 })
  await waitUntil(async () => (await badge.count()) === 0, 5000, 'huy hiệu biến mất')
})

await step('4. Bob trả lời; Alice (đang mở phòng) thấy ngay, không có huy hiệu chưa đọc', async () => {
  await send(bob, 'chào Hà, mình nhận được rồi')
  await bubbles(alice, 'chào Hà, mình nhận được rồi').waitFor({ timeout: 5000 })
  await sleep(500)
  if (await roomItem(alice, GROUP).locator('.unread-badge').count()) throw new Error('Alice có huy hiệu chưa đọc trong phòng đang mở')
})

await step('5. Alice tìm "Quốc Huy" trong "Cuộc trò chuyện mới", nhắn riêng; Bob thấy phòng mới + chưa đọc', async () => {
  await alice.getByRole('button', { name: 'Cuộc trò chuyện mới' }).click()
  const dialog = alice.getByRole('dialog', { name: 'Cuộc trò chuyện mới' })
  await dialog.getByLabel('Tìm người').fill('Quốc Huy')
  await dialog.getByRole('button', { name: new RegExp(escapeRe(BOB.fullName)) }).click()
  await alice.waitForURL(/\/chat\/\d+$/, { timeout: 10000 })
  await alice.locator('.chat-head h2', { hasText: BOB.fullName }).waitFor({ timeout: 10000 })
  directName = ALICE.fullName // phía Bob, phòng 1-1 mang tên người kia
  await send(alice, 'chào Huy')
  await bubbles(alice, 'chào Huy').waitFor({ timeout: 5000 })
  const badge = roomItem(bob, directName).locator('.unread-badge')
  await waitUntil(async () => (await badge.count()) === 1 && (await badge.innerText()).trim() === '1', 10000, 'Bob thấy phòng 1-1 mới với huy hiệu 1')
})

await step('6. Mất mạng: Bob offline, Alice gửi; Bob online lại thấy tin trong 10 giây, không trùng', async () => {
  await openRoom(alice, GROUP)
  const before = sockets.bob.length
  await setBobOffline(true)
  // Chờ trình duyệt của Bob thật sự mất WebSocket (banner "Đang kết nối lại…").
  await waitUntil(() => bob.locator('.conn-banner').count(), 15000, 'Bob thấy banner mất kết nối')
  await send(alice, 'tin lúc Bob mất mạng')
  await waitUntil(async () => Number(await bubbles(alice, 'tin lúc Bob mất mạng').getAttribute('data-message-id')) > 0, 10000, 'tin của Alice được xác nhận')
  await sleep(1000)
  if (await bubbles(bob, 'tin lúc Bob mất mạng').count()) throw new Error('Bob nhận được tin khi đang offline?')
  await setBobOffline(false)
  const t0 = Date.now()
  await expectExactlyOnce(bob, 'tin lúc Bob mất mạng', 10000, 'Bob nhận tin sau khi có mạng')
  await waitUntil(async () => (await bob.locator('.conn-banner').count()) === 0, 10000, 'banner biến mất')
  return `nhận sau ~${Date.now() - t0 - 1500}ms, ${sockets.bob.length - before} WebSocket mới`
})
await setBobOffline(false) // nếu bước trên hỏng giữa chừng: không để các bước sau chạy khi mất mạng

await step('7. Gửi khi mất mạng: "Đang gửi…" rồi được gửi khi có mạng, Bob nhận đúng một lần', async () => {
  await setAliceOffline(true)
  await waitUntil(() => alice.locator('.conn-banner').count(), 15000, 'Alice thấy banner mất kết nối')
  await send(alice, 'gửi lúc offline')
  const mine = bubbles(alice, 'gửi lúc offline')
  await mine.getByText('Đang gửi…').waitFor({ timeout: 3000 })
  await sleep(1500)
  if (await bubbles(bob, 'gửi lúc offline').count()) throw new Error('Bob nhận tin trong lúc Alice offline?')
  await setAliceOffline(false)
  const t0 = Date.now()
  await expectExactlyOnce(bob, 'gửi lúc offline', 15000, 'Bob nhận tin gửi lúc offline')
  const took = Date.now() - t0 - 1500
  await waitUntil(async () => Number(await mine.getAttribute('data-message-id')) > 0, 10000, 'tin của Alice được xác nhận')
  if ((await mine.count()) !== 1) throw new Error(`Alice có ${await mine.count()} bong bóng`)
  if (await mine.getByText('Đang gửi…').count()) throw new Error('vẫn "Đang gửi…"')
  const viaRest = await must('GET', `/rooms/${group.id}/messages?limit=50`, carolToken)
  const n = viaRest.items.filter((m) => m.body === 'gửi lúc offline').length
  if (n !== 1) throw new Error(`máy chủ lưu ${n} bản`)
  return `Bob nhận sau ~${took}ms khi có mạng`
})
await setAliceOffline(false)

await step('8. Sửa và xoá: Bob thấy "(đã sửa)" và "Tin nhắn đã bị xoá" (không còn nội dung)', async () => {
  const target = bubbles(alice, 'xin chào cả nhóm')
  await target.getByRole('button', { name: 'Sửa tin nhắn' }).click()
  await target.getByLabel('Sửa nội dung tin nhắn').fill('xin chào cả nhóm, đã sửa lại')
  await target.getByRole('button', { name: 'Lưu' }).click()
  const edited = bubbles(bob, 'xin chào cả nhóm, đã sửa lại')
  await edited.waitFor({ timeout: 5000 })
  await edited.getByText('(đã sửa)').waitFor({ timeout: 5000 })
  const victim = bubbles(alice, 'gửi lúc offline')
  const id = await victim.getAttribute('data-message-id')
  await victim.getByRole('button', { name: 'Xoá tin nhắn' }).click()
  const gone = msgList(bob).locator(`.msg[data-message-id="${id}"]`)
  await gone.getByText('Tin nhắn đã bị xoá').waitFor({ timeout: 5000 })
  if (await msgList(bob).getByText('gửi lúc offline').count()) throw new Error('Bob vẫn thấy nội dung tin đã xoá')
  if (await msgList(alice).getByText('gửi lúc offline').count()) throw new Error('Alice vẫn thấy nội dung tin đã xoá')
})

await step('9a. Mở phòng có ~130 tin (bù tin khi không xem) nằm đúng đáy; tin mới tự theo khi ở đáy, "↓ N tin mới" khi đã cuộn lên', async () => {
  await openRoom(alice, BOB.fullName) // rời "UI nhóm": phía Alice, phòng 1-1 mang tên Bob
  await botSendMany(carolToken, group.id, Array.from({ length: 120 }, (_, i) => `tin số ${i + 1} — ${'nội dung dài để có nhiều dòng '.repeat(i % 4)}`))
  await openRoom(alice, GROUP)
  await bubbles(alice, 'tin số 120 —').waitFor({ timeout: 10000 })
  const m = await settle(alice)
  if (m.gap > 2) throw new Error(`không nằm ở đáy: gap=${m.gap}`)
  const count = await msgList(alice).locator('.msg').count()

  await botSendMany(carolToken, group.id, ['theo dõi khi ở đáy'])
  await bubbles(alice, 'theo dõi khi ở đáy').waitFor({ timeout: 5000 })
  const m2 = await settle(alice)
  if (m2.gap > 2) throw new Error(`tin mới không kéo xuống đáy: gap=${m2.gap}`)

  await msgList(alice).evaluate((el) => (el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)))
  const up = await settle(alice)
  await botSendMany(carolToken, group.id, ['mới khi cuộn lên 1', 'mới khi cuộn lên 2'])
  await alice.getByRole('button', { name: '↓ 2 tin mới' }).waitFor({ timeout: 5000 })
  const after = await settle(alice)
  if (Math.abs(after.top - up.top) > 2) throw new Error(`vị trí cuộn bị đổi khi có tin mới: ${up.top} -> ${after.top}`)
  await alice.getByRole('button', { name: '↓ 2 tin mới' }).click()
  const bottom = await settle(alice)
  if (bottom.gap > 2) throw new Error(`bấm "↓ tin mới" không xuống đáy: gap=${bottom.gap}`)
  if (await alice.getByRole('button', { name: /tin mới$/ }).count()) throw new Error('nút "tin mới" không biến mất')
  return `${count} tin, gap=${m.gap}/${m2.gap}/${bottom.gap}`
})

await step('9b. Tải lại trang: nằm đúng đáy; cuộn lên đầu tải tin cũ mà vị trí không nhảy (2 lần)', async () => {
  await alice.reload()
  await bubbles(alice, 'mới khi cuộn lên 2').waitFor({ timeout: 10000 })
  const m = await settle(alice)
  if (m.gap > 2) throw new Error(`sau khi tải lại không ở đáy: gap=${m.gap}`)
  const details = [`gap=${m.gap}`]
  for (let round = 1; round <= 2; round++) {
    const n0 = await msgList(alice).locator('.msg').count()
    // Cuộn lên đầu và chọn mốc trong cùng một lượt (trước khi sự kiện scroll kịp kích hoạt tải tin cũ),
    // rồi đo vị trí bong bóng mốc ở MỌI khung hình cho tới khi tải xong: bắt cả giật tạm thời lẫn lệch cuối.
    const anchor = await msgList(alice).evaluate((el) => {
      el.scrollTop = 0
      const top = el.getBoundingClientRect().top
      const msgs = [...el.querySelectorAll('.msg[data-message-id]')].filter((m) => Number(m.dataset.messageId) > 0)
      const first = msgs.find((m) => m.querySelector('.bubble').getBoundingClientRect().bottom > top + 1)
      const id = first.dataset.messageId
      const offset = first.querySelector('.bubble').getBoundingClientRect().top - top
      const samples = []
      window.__scrollSamples = samples
      const tick = () => {
        const b = el.querySelector(`.msg[data-message-id="${id}"] .bubble`)
        if (b) samples.push(b.getBoundingClientRect().top - el.getBoundingClientRect().top - offset)
        if (samples.length < 600 && !window.__stopSamples) requestAnimationFrame(tick)
      }
      window.__stopSamples = false
      requestAnimationFrame(tick)
      return { id, offset, fromBottom: el.scrollHeight - el.scrollTop }
    })
    await waitUntil(async () => (await msgList(alice).locator('.msg').count()) > n0, 10000, `lần ${round}: tải thêm tin cũ`)
    await settle(alice)
    const samples = await alice.evaluate(() => {
      window.__stopSamples = true
      return window.__scrollSamples
    })
    const offset = await offsetOf(alice, anchor.id)
    const fromBottomAfter = await msgList(alice).evaluate((el) => el.scrollHeight - el.scrollTop)
    const shift = offset - anchor.offset
    const worst = samples.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
    if (Math.abs(shift) > 3) throw new Error(`lần ${round}: tin #${anchor.id} lệch ${shift.toFixed(1)}px sau khi tải (scrollHeight-scrollTop ${anchor.fromBottom} -> ${fromBottomAfter})`)
    if (Math.abs(worst) > 3) throw new Error(`lần ${round}: tin #${anchor.id} giật tạm thời ${worst.toFixed(1)}px trong lúc tải (${samples.length} khung hình)`)
    details.push(`lần ${round}: +${(await msgList(alice).locator('.msg').count()) - n0} tin, lệch cuối ${shift.toFixed(1)}px, giật tối đa ${worst.toFixed(1)}px/${samples.length} khung`)
  }
  // Cuộn bằng con lăn chuột cho tới đầu cuộc trò chuyện.
  await msgList(alice).hover()
  await waitUntil(async () => {
    await alice.mouse.wheel(0, -2000)
    return (await msgList(alice).getByText('Đầu cuộc trò chuyện').count()) > 0
  }, 20000, 'cuộn bằng con lăn tới "Đầu cuộc trò chuyện"')
  const total = await msgList(alice).locator('.msg').count()
  if (!(await bubbles(alice, 'tin số 1 —').count())) throw new Error('không thấy tin số 1')
  details.push(`tổng ${total} tin`)
  return details.join('; ')
})

await step('10. An toàn: thẻ HTML hiện như chữ, chỉ https là liên kết (rel đúng), không có alert', async () => {
  const payload = '<img src=x onerror=alert(1)> https://example.com javascript:alert(1)'
  await send(bob, payload)
  const bubble = bubbles(alice, '<img src=x onerror=alert(1)>')
  await bubble.waitFor({ timeout: 5000 })
  const text = (await bubble.locator('.bubble').innerText()).trim()
  if (text !== payload) throw new Error('văn bản khác: ' + text)
  if (await bubble.locator('img').count()) throw new Error('có phần tử img')
  const links = bubble.locator('.bubble a')
  if ((await links.count()) !== 1) throw new Error(`${await links.count()} liên kết`)
  const href = await links.first().getAttribute('href')
  const rel = await links.first().getAttribute('rel')
  if (!/^https:\/\/example\.com\/?$/.test(href)) throw new Error('href=' + href)
  if (rel !== 'noopener noreferrer nofollow') throw new Error('rel=' + rel)
  await sleep(1000)
  if (unexpectedDialogs.length) throw new Error('hộp thoại: ' + unexpectedDialogs.join(' | '))
})

await step('11. Token: localStorage/sessionStorage rỗng, không URL WebSocket/yêu cầu nào chứa token', async () => {
  const sizes = await alice.evaluate(() => [localStorage.length, sessionStorage.length])
  if (sizes[0] || sizes[1]) throw new Error('storage không rỗng: ' + JSON.stringify(sizes))
  if (!sockets.alice.length) throw new Error('không ghi nhận WebSocket nào')
  const bad = [...sockets.alice.map((s) => s.url), ...aliceRequests].filter((u) => /token|eyJ[A-Za-z0-9_-]{10,}/i.test(u))
  if (bad.length) throw new Error('URL chứa token: ' + bad[0])
  const wsUrls = [...new Set(sockets.alice.map((s) => s.url))]
  return `${sockets.alice.length} WebSocket (${wsUrls.join(', ')}), ${aliceRequests.length} yêu cầu`
})

await step('12. Điện thoại 390px: không cuộn ngang; danh sách hoặc hội thoại (có "Về danh sách")', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'vi-VN', isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  pages.mobile = page
  watch(page, 'mobile')
  try {
    await login(page, ALICE.username, ALICE_PW)
    await roomItem(page, GROUP).waitFor({ timeout: 10000 })
    const noHScroll = async (where) => {
      const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
      if (sw > iw) throw new Error(`${where}: cuộn ngang ${sw} > ${iw}`)
    }
    await noHScroll('danh sách')
    if (!(await sidebar(page).isVisible())) throw new Error('danh sách bị ẩn')
    if (await page.locator('.chat-main').isVisible()) throw new Error('khung hội thoại hiện cùng danh sách')
    await roomItem(page, GROUP).click()
    await bubbles(page, 'mới khi cuộn lên 2').waitFor({ timeout: 10000 })
    await noHScroll('hội thoại')
    if (await sidebar(page).isVisible()) throw new Error('danh sách vẫn hiện khi mở phòng')
    const back = page.getByRole('link', { name: 'Về danh sách' })
    if (!(await back.isVisible())) throw new Error('không thấy nút "Về danh sách"')
    await back.click()
    await roomItem(page, GROUP).waitFor({ timeout: 5000 })
    if (await page.locator('.chat-main').isVisible()) throw new Error('khung hội thoại vẫn hiện sau khi về danh sách')
  } finally {
    delete pages.mobile
    await ctx.close()
  }
})

await step('13. Admin: thấy nhóm, tạo "UI nhóm 2", lưu trữ (gõ đúng tên), thành viên mất nhóm ngay; khôi phục thì có lại nhóm và tin', async () => {
  const ctx = await browser.newContext(desktop)
  const admin = await ctx.newPage()
  pages.admin = admin
  watch(admin, 'admin')
  try {
    await login(admin, ADMIN_USER, ADMIN_PW)
    await admin.getByText('Xin chào,').waitFor({ timeout: 10000 })
    await admin.goto(BASE + '/admin/rooms')
    await admin.getByRole('heading', { name: 'Phòng và nhóm' }).waitFor({ timeout: 10000 })
    await admin.locator('.table-row', { hasText: GROUP }).first().waitFor({ timeout: 10000 })

    // Tạo nhóm 2 với một thành viên (Alice) qua giao diện.
    const form = admin.locator('form', { hasText: 'Tạo nhóm mới' })
    await form.getByLabel('Tên nhóm').fill(GROUP2)
    await form.getByLabel('Lọc người dùng').fill(ALICE.username)
    await form.locator('label', { hasText: ALICE.username }).getByRole('checkbox').check()
    await form.getByRole('button', { name: 'Tạo nhóm' }).click()
    const row = admin.locator('.table-row', { hasText: GROUP2 })
    await row.waitFor({ timeout: 10000 })
    await roomItem(alice, GROUP2).waitFor({ timeout: 10000 }) // rooms_changed tới Alice, không tải lại
    await openRoom(alice, GROUP2)
    await send(alice, 'tin bí mật nhóm 2')
    await waitUntil(async () => Number(await bubbles(alice, 'tin bí mật nhóm 2').getAttribute('data-message-id')) > 0, 10000, 'tin nhóm 2 được gửi')

    // Lưu trữ: gõ sai tên thì nút vẫn tắt.
    await admin.getByRole('button', { name: `Quản lý ${GROUP2}` }).click()
    const confirmBox = admin.getByLabel('Gõ tên nhóm để xác nhận')
    const archiveBtn = admin.getByRole('button', { name: 'Lưu trữ nhóm' })
    await confirmBox.fill(GROUP2.toUpperCase())
    if (await archiveBtn.isEnabled()) throw new Error('nút bật khi gõ sai tên (khác hoa thường)')
    await confirmBox.fill(GROUP2.slice(0, -1))
    if (await archiveBtn.isEnabled()) throw new Error('nút bật khi gõ thiếu tên')
    await confirmBox.fill(GROUP2)
    if (!(await archiveBtn.isEnabled())) throw new Error('nút vẫn tắt khi gõ đúng tên')
    await archiveBtn.click()
    await waitUntil(async () => (await row.count()) === 0, 10000, 'nhóm rời tab Đang hoạt động')

    // Thành viên mất nhóm ngay, trang đang mở nhóm chuyển sang "không tồn tại".
    await waitUntil(async () => (await roomItem(alice, GROUP2).count()) === 0, 10000, 'nhóm biến mất khỏi danh sách của Alice')
    await alice.getByText('Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.').waitFor({ timeout: 5000 })

    // Tab "Đã lưu trữ": có nhóm và hạn xoá (~3 ngày).
    await admin.getByRole('tab', { name: 'Đã lưu trữ' }).click()
    const archivedRow = admin.locator('.table-row', { hasText: GROUP2 })
    await archivedRow.waitFor({ timeout: 10000 })
    const purge = await archivedRow.getByText(/Xoá vĩnh viễn vào/).innerText()
    const archivedApi = await must('GET', `/admin/rooms?archived=true&q=${encodeURIComponent(GROUP2)}`, adminToken)
    const purgeAt = new Date(archivedApi[0]?.purge_at)
    const days = (purgeAt - Date.now()) / 86400000
    if (!(days > 2.9 && days <= 3.01)) throw new Error(`hạn xoá ${archivedApi[0]?.purge_at} cách ${days.toFixed(2)} ngày`)

    // Admin không thấy nội dung tin nhắn (giao diện lẫn API).
    for (const secret of ['tin bí mật nhóm 2', 'xin chào cả nhóm', 'tin số 1']) {
      if ((await admin.content()).includes(secret)) throw new Error('trang admin chứa nội dung tin: ' + secret)
    }
    const peek = await http('GET', `/rooms/${archivedApi[0].id}/messages`, adminToken)
    const peek1 = await http('GET', `/rooms/${group.id}/messages`, adminToken)
    if (peek.status !== 404 || peek1.status !== 404) throw new Error(`admin đọc được tin: ${peek.status}/${peek1.status}`)
    const detail = await must('GET', `/admin/rooms/${group.id}`, adminToken)
    if (JSON.stringify(detail).includes('xin chào')) throw new Error('chi tiết nhóm của admin chứa nội dung tin')

    // Khôi phục.
    await admin.getByRole('button', { name: `Khôi phục ${GROUP2}` }).click()
    await waitUntil(async () => (await archivedRow.count()) === 0, 10000, 'nhóm rời tab Đã lưu trữ')
    await roomItem(alice, GROUP2).waitFor({ timeout: 10000 })
    await openRoom(alice, GROUP2)
    await bubbles(alice, 'tin bí mật nhóm 2').waitFor({ timeout: 10000 })
    await admin.getByRole('tab', { name: 'Đang hoạt động' }).click()
    await admin.locator('.table-row', { hasText: GROUP2 }).waitFor({ timeout: 10000 })
    return purge
  } finally {
    delete pages.admin
    await ctx.close()
  }
})

await step('14. Khoá ui.bob: trang của Bob về đăng nhập trong ~40 giây, không vòng lặp kết nối lại', async () => {
  await openRoom(bob, GROUP)
  await waitUntil(async () => (await bob.locator('.conn-banner').count()) === 0, 10000, 'Bob đang kết nối')
  const t0 = Date.now()
  await must('PATCH', `/admin/users/${bobId}`, adminToken, { is_active: false })
  await bob.getByRole('heading', { name: 'Đăng nhập' }).waitFor({ timeout: 45000 })
  const took = Date.now() - t0
  const n = sockets.bob.length
  await sleep(8000)
  if (sockets.bob.length !== n) throw new Error(`${sockets.bob.length - n} WebSocket mới sau khi về đăng nhập`)
  if (!(await bob.getByRole('heading', { name: 'Đăng nhập' }).isVisible())) throw new Error('rời khỏi trang đăng nhập')
  return `về đăng nhập sau ${took}ms`
})

await step('15. Không có lỗi pageerror', async () => {
  if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '))
})

await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
