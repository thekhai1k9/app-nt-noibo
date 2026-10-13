// Kiểm tra giao diện chat trên trình duyệt thật (Playwright/Chromium) qua toàn bộ stack Docker.
//
// CHỈ DÙNG TRÊN STACK THỬ NGHIỆM: script tạo người dùng, nhóm, đổi mật khẩu admin và khoá một tài khoản.
//
// Stack thử nghiệm phải chạy với MAX_OWNED_GROUPS=3 (bước giới hạn số nhóm làm chủ) và MENTION_ALL_PER_WINDOW=3
// (bước giới hạn tin @all) trong .env.
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
const CAROL_PW = 'UiCarolPassw0rd!'
const DAVE_PW = 'UiDavePassw0rd!'
const TAG = Date.now().toString(36).slice(-6)
const ALICE = { username: `ui.alice.${TAG}`, fullName: `Lê Thu Hà ${TAG}` }
const BOB = { username: `ui.bob.${TAG}`, fullName: `Trần Quốc Huy ${TAG}` }
const CAROL = { username: `ui.carol.${TAG}`, fullName: `Bot Gửi Tin ${TAG}` }
const DAVE = { username: `ui.dave.${TAG}`, fullName: `Người Ngoài ${TAG}` } // không chung phòng nào với Alice
const GROUP = `UI nhóm ${TAG}`
const GROUP2 = `UI nhóm 2 ${TAG}`
const GROUP_DAVE = `UI nhóm Dave ${TAG}` // chỉ Bob và Dave
const UGROUP = `Nhóm liên chi nhánh ${TAG}` // nhóm do Alice (người dùng thường) tạo qua giao diện
const UGROUP2 = `Liên chi nhánh đổi tên ${TAG}`
const BRANCH_B = { name: `UI chi nhánh B ${TAG}`, code: `B${TAG}` } // Bob ở chi nhánh khác Alice

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
  const frames = [] // mọi frame nhận được (kiểm "không nhận được gì")
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)
    frames.push({ at: Date.now(), data })
    if (data.type === 'ready') readyResolve()
    const cid = data.message?.client_id ?? data.client_id
    if (cid && waiters.has(cid)) {
      waiters.get(cid)(data)
      waiters.delete(cid)
    }
  }
  await ready
  let n = 0
  /** Gửi một tin (kèm `extra`: reply_to_id, mentions, mention_all); trả frame phản hồi (`message` hoặc `error`) cho đúng client_id. */
  const attempt = (roomId, body, extra = {}) => {
    const clientId = `bot-${TAG}-${Date.now()}-${n++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bot: gửi quá hạn')), 10000)
      waiters.set(clientId, (data) => {
        clearTimeout(timer)
        resolve(data)
      })
      ws.send(JSON.stringify({ ...extra, type: 'send', room_id: roomId, body, client_id: clientId }))
    })
  }
  return {
    frames,
    attempt,
    async send(roomId, body, extra = {}) {
      const data = await attempt(roomId, body, extra)
      if (data.type !== 'message') throw new Error('bot: lỗi ' + JSON.stringify(data))
      return data.message
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
let adminToken = await restReady(ADMIN_USER, ADMIN_TEMP_PASSWORD, ADMIN_PW)
const branches = await must('GET', '/admin/branches', adminToken)
if (!branches.length) throw new Error('chưa có chi nhánh nào')
const branchId = branches[0].id
const branchB = await must('POST', '/admin/branches', adminToken, BRANCH_B)
const created = {}
for (const u of [ALICE, BOB, CAROL, DAVE]) {
  const userBranch = u === BOB ? branchB.id : branchId
  created[u.username] = await must('POST', '/admin/users', adminToken, { username: u.username, full_name: u.fullName, branch_id: userBranch, role: 'member' })
}
const aliceId = created[ALICE.username].id
const bobId = created[BOB.username].id
const carolId = created[CAROL.username].id
const daveId = created[DAVE.username].id
const group = await must('POST', '/admin/rooms', adminToken, { name: GROUP, branch_id: branchId, member_ids: [aliceId, bobId, carolId] })
let carolToken = await restReady(CAROL.username, created[CAROL.username].temp_password, CAROL_PW)
const groupDave = await must('POST', '/admin/rooms', adminToken, { name: GROUP_DAVE, branch_id: branchId, member_ids: [bobId, daveId] })
const daveToken = await restReady(DAVE.username, created[DAVE.username].temp_password, DAVE_PW)

// ---------------- trình duyệt ----------------

// channel 'chromium' = Chromium đầy đủ ở chế độ headless mới: chromium-headless-shell (mặc định) luôn báo
// Notification.permission = 'denied' dù đã cấp quyền, nên không kiểm được thông báo trình duyệt.
const browser = await chromium.launch({ headless: !process.env.HEADED, channel: 'chromium' })
const desktop = { viewport: { width: 1280, height: 800 }, locale: 'vi-VN' }
const aliceCtx = await browser.newContext(desktop)
const bobCtx = await browser.newContext(desktop)
const sockets = { alice: [], bob: [] }
const clientFrames = { alice: [], bob: [] } // frame `send` mà trang gửi lên máy chủ (không ghi frame auth)

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
    // Đã đặt onMessage thì Playwright không tự chuyển tiếp chiều client -> server nữa: tự chuyển, ghi lại frame `send`.
    ws.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"send"')) {
        const data = JSON.parse(message)
        if (data.type === 'send') clientFrames[who].push(data)
      }
      server.send(message)
    })
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
let bob = await bobCtx.newPage()
pages.alice = alice
pages.bob = bob

const pageErrors = []
const unexpectedDialogs = []
const acceptedConfirms = []
const aliceRequests = []
// Hộp xác nhận mà các bước cố ý kích hoạt (xoá tin, gỡ thành viên, rời nhóm); mọi hộp thoại khác là lỗi.
const EXPECTED_CONFIRMS = [/^Xoá tin nhắn/, /^Gỡ .+ khỏi nhóm "/, /^Bạn là chủ nhóm "/, /^Rời nhóm "/]
function watch(page, who) {
  page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`))
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm' && EXPECTED_CONFIRMS.some((re) => re.test(dialog.message()))) {
      acceptedConfirms.push(`${who}: ${dialog.message()}`)
      await dialog.accept()
    } else {
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
    const purge = await archivedRow.getByText(/Xoá vĩnh viễn sau/).innerText()
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

// ---------------- đã xem / đang soạn tin / online ----------------

const presenceDot = (page, name) => roomItem(page, name).locator('.presence-dot')
const presenceLine = (page) => page.locator('.chat-head .presence-line', { hasText: 'Đang hoạt động' })
const typingText = async (page) => (await page.locator('.typing-indicator').innerText()).trim()
const seenLabels = (page) => msgList(page).locator('.seen-label')
/** Nhãn "đã xem" nằm ngay dưới đúng tin `id`. */
const seenUnder = (page, id) => msgList(page).locator(`.msg[data-message-id="${id}"] + .seen-row .seen-label`)

/** Điều kiện phải đúng liên tục trong `ms` (kiểm lặp lại, lỗi trong fn làm hỏng ngay). */
async function holdsFor(fn, ms, what) {
  const end = Date.now() + ms
  let checks = 0
  while (Date.now() < end) {
    if (!(await fn())) throw new Error(`${what} (lần kiểm thứ ${checks + 1})`)
    checks++
    await sleep(250)
  }
  if (checks < 2) throw new Error(`${what}: chỉ kiểm được ${checks} lần`)
}

/** Id online mà người giữ `token` được thấy qua REST. */
async function onlineIds(token) {
  const data = await must('GET', '/presence', token)
  if (!Array.isArray(data?.online_user_ids)) throw new Error('GET /presence trả sai dạng: ' + JSON.stringify(data))
  return data.online_user_ids
}

/** Chờ tin chứa `text` trên `page` được máy chủ xác nhận; trả id. */
async function confirmedId(page, text) {
  let id = 0
  await waitUntil(async () => (id = Number(await bubbles(page, text).getAttribute('data-message-id'))) > 0, 10000, `tin "${text}" được xác nhận`)
  return id
}

/** Mở một tab mới của Bob (cùng phiên qua cookie refresh), dừng ở danh sách phòng. */
async function openBobTab(label = 'bob') {
  const page = await bobCtx.newPage()
  watch(page, label)
  pages[label] = page
  await page.goto(BASE + '/')
  await roomItem(page, GROUP).waitFor({ timeout: 10000 })
  return page
}

let aliceToken = ''
let bobToken = ''
let directRoomId = 0

await step('14. Online: Alice thấy chấm của Bob; Bob đóng trang -> chấm mất (≤20 giây), mở lại -> có lại; hai tab đóng một vẫn online', async () => {
  aliceToken = await restReady(ALICE.username, ALICE_PW)
  bobToken = await restReady(BOB.username, BOB_PW)
  await openRoom(alice, BOB.fullName)
  directRoomId = Number(new URL(alice.url()).pathname.split('/').pop())
  if (!(directRoomId > 0)) throw new Error('không lấy được id phòng 1-1 từ URL ' + alice.url())
  const dot = presenceDot(alice, BOB.fullName)
  await waitUntil(async () => (await dot.count()) === 1, 10000, 'Alice thấy chấm online của Bob')
  await presenceLine(alice).waitFor({ timeout: 5000 })
  if (!(await onlineIds(aliceToken)).includes(bobId)) throw new Error('GET /presence của Alice không có Bob dù Bob đang mở trang')

  // Bob đóng tab duy nhất.
  const t0 = Date.now()
  await bob.close()
  await waitUntil(async () => (await dot.count()) === 0, 20000, 'chấm của Bob biến mất sau khi Bob đóng trang')
  const goneMs = Date.now() - t0
  if (await presenceLine(alice).count()) throw new Error('đầu hội thoại vẫn "Đang hoạt động"')
  if ((await onlineIds(aliceToken)).includes(bobId)) throw new Error('GET /presence vẫn có Bob sau khi chấm mất')

  // Bob mở lại.
  const t1 = Date.now()
  bob = await openBobTab()
  await waitUntil(async () => (await dot.count()) === 1, 20000, 'chấm trở lại khi Bob mở lại trang')
  const backMs = Date.now() - t1

  // Hai tab: mở tab thứ hai, chờ nó có WebSocket đã kết nối, rồi đóng tab CŨ.
  const nBefore = sockets.bob.length
  const second = await openBobTab('bob2')
  await waitUntil(() => sockets.bob.length > nBefore, 10000, 'tab thứ hai của Bob mở WebSocket')
  await waitUntil(async () => (await second.locator('.conn-banner').count()) === 0, 10000, 'tab thứ hai đã kết nối')
  await sleep(1000) // để kết nối thứ hai kịp xác thực và ghi presence
  await bob.close()
  delete pages.bob2
  bob = second
  pages.bob = bob
  await holdsFor(async () => (await dot.count()) === 1, 8000, 'chấm của Bob biến mất dù Bob còn một tab mở')
  if (!(await onlineIds(aliceToken)).includes(bobId)) throw new Error('GET /presence mất Bob dù Bob còn một tab mở')
  return `mất sau ${goneMs}ms, có lại sau ${backMs}ms, giữ nguyên 8 giây sau khi đóng 1/2 tab`
})

await step('15. Đang soạn tin: Bob gõ -> Alice thấy trong 2 giây; dừng gõ -> mất trong 6 giây; gửi tin -> mất ngay', async () => {
  await openRoom(alice, BOB.fullName)
  await openRoom(bob, ALICE.fullName)
  const expected = `${BOB.fullName} đang soạn tin…`
  if (await typingText(alice)) throw new Error('dòng "đang soạn" có sẵn trước khi Bob gõ: ' + (await typingText(alice)))
  const box = bob.getByLabel('Nhập tin nhắn')
  const t0 = Date.now()
  const typing = box.pressSequentially('dang go thu', { delay: 60 })
  await waitUntil(async () => (await typingText(alice)) === expected, 2000, 'Alice thấy "Bob … đang soạn tin…"')
  const shownMs = Date.now() - t0
  await typing
  const t1 = Date.now()
  if (await typingText(bob)) throw new Error('Bob thấy chính mình đang soạn tin')
  await waitUntil(async () => (await typingText(alice)) === '', 6000, 'dòng "đang soạn" biến mất sau khi Bob dừng gõ')
  const goneMs = Date.now() - t1
  if (goneMs < 1000) throw new Error(`dòng "đang soạn" mất quá sớm (${goneMs}ms) ngay khi Bob vừa dừng gõ`)

  // Gõ tiếp (đã quá giới hạn 3 giây phía client) rồi gửi: dòng mất ngay khi tin tới.
  await sleep(Math.max(0, 3500 - (Date.now() - t1)))
  await box.pressSequentially(' tin sau khi go', { delay: 20 })
  await waitUntil(async () => (await typingText(alice)) === expected, 3000, 'Alice thấy Bob soạn lần hai')
  const t2 = Date.now()
  await box.press('Enter')
  await bubbles(alice, 'dang go thu tin sau khi go').waitFor({ timeout: 5000 })
  await waitUntil(async () => (await typingText(alice)) === '', 1500, 'dòng "đang soạn" mất ngay khi Bob gửi tin')
  const clearMs = Date.now() - t2
  return `hiện sau ${shownMs}ms, mất ${goneMs}ms sau khi dừng gõ, mất ${clearMs}ms sau khi bấm gửi`
})

await step('16. Đã xem: 1-1 chưa mở phòng thì không có nhãn, mở thì "Đã xem" ≤3 giây; nhóm "Đã xem bởi 1 người" rồi "2 người"', async () => {
  // 1-1: Bob rời phòng 1-1 trước khi Alice gửi.
  await openRoom(bob, GROUP)
  await openRoom(alice, BOB.fullName)
  await send(alice, 'Huy chưa mở phòng này')
  const id = await confirmedId(alice, 'Huy chưa mở phòng này')
  await holdsFor(async () => (await seenLabels(alice).count()) === 0, 2500, 'có nhãn "Đã xem" dù Bob chưa mở phòng')
  await openRoom(bob, ALICE.fullName)
  const t0 = Date.now() // Bob đã tải xong phòng
  await waitUntil(async () => (await seenUnder(alice, id).count()) === 1, 3000, 'Alice thấy "Đã xem" dưới tin cuối')
  const directMs = Date.now() - t0
  const text = (await seenUnder(alice, id).innerText()).trim()
  if (text !== 'Đã xem') throw new Error(`nhãn 1-1 là "${text}"`)
  if ((await seenLabels(alice).count()) !== 1) throw new Error(`${await seenLabels(alice).count()} nhãn "Đã xem" (mong đợi 1)`)

  // Nhóm 3 người (Alice, Bob, Carol): Bob đang ở phòng 1-1, Carol không mở gì.
  await openRoom(alice, GROUP)
  await send(alice, 'đếm người đã xem')
  const gid = await confirmedId(alice, 'đếm người đã xem')
  await holdsFor(async () => (await seenLabels(alice).count()) === 0, 2500, 'có nhãn đã xem khi chưa ai đọc tin nhóm')
  await openRoom(bob, GROUP)
  const t1 = Date.now()
  await waitUntil(async () => (await seenUnder(alice, gid).count()) === 1 && (await seenUnder(alice, gid).innerText()).trim() === 'Đã xem bởi 1 người', 3000, '"Đã xem bởi 1 người"')
  const groupMs = Date.now() - t1
  const title1 = await seenUnder(alice, gid).getAttribute('title')
  if (title1 !== BOB.fullName) throw new Error(`title là "${title1}" (mong đợi tên Bob)`)
  await must('POST', `/rooms/${group.id}/read`, carolToken, { message_id: gid })
  await waitUntil(async () => (await seenUnder(alice, gid).innerText()).trim() === 'Đã xem bởi 2 người', 3000, '"Đã xem bởi 2 người" khi Carol đọc')
  const title2 = await seenUnder(alice, gid).getAttribute('title')
  if (!title2?.includes(BOB.fullName) || !title2.includes(CAROL.fullName)) throw new Error(`title là "${title2}"`)
  if ((await seenLabels(alice).count()) !== 1) throw new Error(`${await seenLabels(alice).count()} nhãn trong nhóm (mong đợi 1)`)
  return `1-1 sau ${directMs}ms, nhóm sau ${groupMs}ms; title "${title2}"`
})

await step('17. Sau mất mạng: Bob đọc, gửi tin rồi offline khi Alice mất mạng; Alice nối lại thấy "Đã xem", tin bù và Bob offline', async () => {
  await openRoom(alice, BOB.fullName) // Bob đang ở nhóm (bước trước), không xem phòng 1-1
  const dot = presenceDot(alice, BOB.fullName)
  await waitUntil(async () => (await dot.count()) === 1, 10000, 'Alice thấy Bob online trước khi mất mạng')
  await send(alice, 'tin trước khi mất mạng')
  const id = await confirmedId(alice, 'tin trước khi mất mạng')
  await holdsFor(async () => (await seenLabels(alice).count()) === 0, 2000, 'có nhãn đã xem trước khi Bob đọc')

  await setAliceOffline(true)
  await waitUntil(() => alice.locator('.conn-banner').count(), 15000, 'Alice thấy banner mất kết nối')
  await openRoom(bob, ALICE.fullName)
  await bubbles(bob, 'tin trước khi mất mạng').waitFor({ timeout: 5000 })
  await waitUntil(async () => {
    const members = await must('GET', `/rooms/${directRoomId}/members`, bobToken)
    const me = members.find((m) => m.user_id === bobId)
    return me?.last_read_message_id != null && me.last_read_message_id >= id
  }, 10000, 'máy chủ ghi nhận Bob đã đọc tin của Alice')
  await send(bob, 'Bob gửi lúc Alice mất mạng 1')
  await confirmedId(bob, 'Bob gửi lúc Alice mất mạng 1')
  await send(bob, 'Bob gửi lúc Alice mất mạng 2')
  await confirmedId(bob, 'Bob gửi lúc Alice mất mạng 2')
  await bob.close()
  await waitUntil(async () => !(await onlineIds(aliceToken)).includes(bobId), 20000, 'máy chủ coi Bob offline')
  // Alice thật sự lỡ các sự kiện: chưa có nhãn, chưa có tin; chấm cũ (nếu còn) là trạng thái cũ phải được sửa khi nối lại.
  const staleDot = (await dot.count()) === 1
  if (await seenUnder(alice, id).count()) throw new Error('Alice nhận "đã xem" khi đang mất mạng?')
  if (await bubbles(alice, 'Bob gửi lúc Alice mất mạng 1').count()) throw new Error('Alice nhận tin khi đang mất mạng?')

  await setAliceOffline(false)
  const t0 = Date.now()
  await waitUntil(async () => (await alice.locator('.conn-banner').count()) === 0, 15000, 'Alice nối lại')
  await waitUntil(async () => (await seenUnder(alice, id).count()) === 1, 10000, 'Alice thấy "Đã xem" sau khi nối lại')
  await waitUntil(async () => (await dot.count()) === 0, 10000, 'chấm online cũ của Bob biến mất sau khi nối lại')
  const fixedMs = Date.now() - t0
  await expectExactlyOnce(alice, 'Bob gửi lúc Alice mất mạng 1', 10000, 'Alice nhận tin bù 1')
  await expectExactlyOnce(alice, 'Bob gửi lúc Alice mất mạng 2', 10000, 'Alice nhận tin bù 2')
  await holdsFor(async () => (await dot.count()) === 0 && (await presenceLine(alice).count()) === 0, 3000, 'Bob lại hiện online dù đã đóng trang')
  const label = (await seenUnder(alice, id).innerText()).trim()
  if (label !== 'Đã xem') throw new Error(`nhãn là "${label}"`)

  // Bob quay lại: sự kiện trực tiếp vẫn tới Alice sau khi nối lại.
  bob = await openBobTab()
  await waitUntil(async () => (await dot.count()) === 1, 20000, 'Alice thấy Bob online lại')
  return `"Đã xem" và offline đúng sau ~${fixedMs}ms kể từ khi có mạng (chấm cũ ${staleDot ? 'còn' : 'không còn'} lúc mất mạng)`
})
await setAliceOffline(false)
if (bob.isClosed()) bob = await openBobTab() // nếu bước trên hỏng giữa chừng: các bước sau vẫn cần trang của Bob

await step('18. Riêng tư: Dave (không chung phòng với Alice) online; Bob thấy, GET /presence của Alice không có Dave', async () => {
  const dave = await openBot(daveToken)
  try {
    await waitUntil(async () => (await onlineIds(bobToken)).includes(daveId), 10000, 'Bob (chung nhóm với Dave) thấy Dave online')
    await holdsFor(async () => {
      const ids = await onlineIds(aliceToken)
      if (ids.includes(daveId)) throw new Error('GET /presence của Alice chứa id của Dave')
      if (ids.includes(aliceId)) throw new Error('GET /presence của Alice chứa chính Alice')
      return ids.includes(bobId) // đối chứng: token của Alice vẫn thấy người chung phòng
    }, 4000, 'GET /presence của Alice không có Bob (đối chứng)')
    const peek = await http('GET', `/rooms/${groupDave.id}/members`, aliceToken)
    if (peek.status !== 404 || peek.data?.detail !== 'room_not_found') throw new Error(`Alice xem được thành viên nhóm của Dave: ${peek.status} ${JSON.stringify(peek.data)}`)
    if (await alice.getByText(DAVE.fullName).count()) throw new Error('giao diện của Alice có tên Dave')
    return `Alice thấy ${JSON.stringify(await onlineIds(aliceToken))}, Bob thấy cả Dave`
  } finally {
    dave.close()
  }
})

// ---------------- nhóm do người dùng thường tạo và quản lý ----------------

const groupPanel = (page) => page.getByRole('dialog', { name: 'Thông tin nhóm' })
const panelMembers = (page) => groupPanel(page).getByRole('list', { name: 'Danh sách thành viên' }).locator('li')
const NOT_IN_ROOM = 'Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.'
const extraContexts = []
let carol = null
let dave = null
let ugroupId = 0

/** Trang trình duyệt riêng (context riêng) cho một người dùng đã đổi mật khẩu. */
async function openUserPage(who, u, password) {
  const ctx = await browser.newContext(desktop)
  extraContexts.push(ctx)
  const page = await ctx.newPage()
  watch(page, who)
  pages[who] = page
  await login(page, u.username, password)
  await page.getByText(`Xin chào, ${u.fullName}`).waitFor({ timeout: 10000 })
  return page
}

/** Đánh dấu trang; còn dấu nghĩa là trang chưa bị tải lại. */
const markPage = (page) => page.evaluate(() => (window.__e2eNoReload = true))
async function notReloaded(page, who) {
  if (!(await page.evaluate(() => window.__e2eNoReload === true))) throw new Error(`trang của ${who} đã bị tải lại`)
}

/** Phòng `id` trong GET /rooms của người giữ `token` (undefined nếu không có). */
async function myRoom(token, id) {
  const rooms = await must('GET', '/rooms', token)
  return rooms.find((r) => r.id === id)
}

/** Tên các thành viên đang hiện trong bảng "Thông tin nhóm". */
const panelNames = (page) => panelMembers(page).locator('.member-name').allInnerTexts()

async function openPanel(page) {
  await page.getByRole('button', { name: 'Thông tin nhóm' }).click()
  await groupPanel(page).waitFor({ timeout: 5000 })
}

/** Số điều khiển chỉ chủ nhóm có, trong bảng đang mở. */
async function managerControls(page) {
  const panel = groupPanel(page)
  return {
    name: await panel.getByLabel('Tên nhóm', { exact: true }).count(),
    save: await panel.getByRole('button', { name: 'Lưu tên' }).count(),
    add: await panel.getByLabel('Thêm thành viên').count(),
    remove: await panel.getByRole('button', { name: /^Gỡ .+ khỏi nhóm$/ }).count(),
    dissolve: await panel.getByRole('button', { name: 'Giải tán nhóm' }).count(),
  }
}

async function expectStatus(method, urlPath, token, body, status, detail, what) {
  const r = await http(method, urlPath, token, body)
  if (r.status !== status || r.data?.detail !== detail) throw new Error(`${what}: ${method} ${urlPath} -> ${r.status} ${JSON.stringify(r.data)} (mong đợi ${status} ${detail})`)
}

await step('19. Alice (chi nhánh A) tạo nhóm qua "Tạo nhóm" với Bob (chi nhánh B) và Carol; Bob/Carol thấy nhóm không cần tải lại; tin tới cả hai', async () => {
  carol = await openUserPage('carol', CAROL, CAROL_PW)
  await roomItem(carol, GROUP).waitFor({ timeout: 10000 })
  await roomItem(bob, GROUP).waitFor({ timeout: 10000 })
  if ((await roomItem(bob, UGROUP).count()) || (await roomItem(carol, UGROUP).count())) throw new Error('nhóm đã có trước khi tạo?')
  await markPage(bob)
  await markPage(carol)

  await alice.getByRole('button', { name: 'Cuộc trò chuyện mới' }).click()
  const dialog = alice.getByRole('dialog', { name: 'Cuộc trò chuyện mới' })
  await dialog.getByRole('tab', { name: 'Tạo nhóm' }).click()
  await dialog.getByLabel('Tên nhóm').fill(UGROUP)
  const search = dialog.getByLabel('Tìm người để thêm')
  for (const [u, branchName] of [[BOB, BRANCH_B.name], [CAROL, branches[0].name]]) {
    await search.fill(u.fullName)
    const row = dialog.locator('label.pick-row', { hasText: u.fullName })
    await row.waitFor({ timeout: 5000 })
    const text = await row.innerText()
    if (!text.includes(branchName)) throw new Error(`dòng "${text}" không ghi chi nhánh ${branchName}`)
    await row.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: `Bỏ ${u.fullName}` }).waitFor({ timeout: 3000 })
  }
  await dialog.getByRole('button', { name: 'Tạo nhóm', exact: true }).click()
  await alice.waitForURL(/\/chat\/\d+$/, { timeout: 10000 })
  await alice.locator('.chat-head h2', { hasText: new RegExp(`^${escapeRe(UGROUP)}$`) }).waitFor({ timeout: 10000 })
  if (await dialog.count()) throw new Error('hộp thoại vẫn mở sau khi tạo nhóm')
  ugroupId = Number(new URL(alice.url()).pathname.split('/').pop())

  const mine = await myRoom(aliceToken, ugroupId)
  if (mine?.type !== 'group' || mine.my_role !== 'owner' || mine.branch_id !== null || mine.member_count !== 3) throw new Error('GET /rooms của Alice: ' + JSON.stringify(mine))
  const members = await must('GET', `/rooms/${ugroupId}/members`, aliceToken)
  const roles = Object.fromEntries(members.map((m) => [m.user_id, m.role]))
  if (members.length !== 3 || roles[aliceId] !== 'owner' || roles[bobId] !== 'member' || roles[carolId] !== 'member') throw new Error('vai trò: ' + JSON.stringify(roles))

  await roomItem(bob, UGROUP).waitFor({ timeout: 10000 })
  await roomItem(carol, UGROUP).waitFor({ timeout: 10000 })
  await notReloaded(bob, 'Bob')
  await notReloaded(carol, 'Carol')
  if ((await myRoom(bobToken, ugroupId))?.my_role !== 'member') throw new Error('my_role của Bob không phải member')

  await openRoom(carol, UGROUP)
  await send(alice, 'chào nhóm liên chi nhánh')
  await confirmedId(alice, 'chào nhóm liên chi nhánh')
  await bubbles(carol, 'chào nhóm liên chi nhánh').waitFor({ timeout: 5000 })
  const badge = roomItem(bob, UGROUP).locator('.unread-badge')
  await waitUntil(async () => (await badge.count()) === 1 && (await badge.innerText()).trim() === '1', 10000, 'Bob thấy huy hiệu "1" ở nhóm mới')
  await openRoom(bob, UGROUP)
  await bubbles(bob, 'chào nhóm liên chi nhánh').waitFor({ timeout: 5000 })
  return `nhóm #${ugroupId}`
})

let carolBot = null
await step('20. Chủ nhóm Alice: đổi tên (Bob thấy ngay), thêm Dave (thấy lịch sử, không chưa đọc), gỡ Carol bằng bàn phím (focus ở lại hộp thoại; Carol mất nhóm ngay, REST 404, WS không gửi/nhận)', async () => {
  await openRoom(alice, UGROUP)
  await openPanel(alice)
  await waitUntil(async () => (await panelMembers(alice).count()) === 3, 5000, 'bảng có 3 thành viên')
  const c = await managerControls(alice)
  if (c.name !== 1 || c.add !== 1 || c.remove !== 2 || c.dissolve !== 1) throw new Error('chủ nhóm thiếu điều khiển: ' + JSON.stringify(c))

  // Đổi tên.
  await groupPanel(alice).getByLabel('Tên nhóm', { exact: true }).fill(UGROUP2)
  await groupPanel(alice).getByRole('button', { name: 'Lưu tên' }).click()
  await roomItem(bob, UGROUP2).waitFor({ timeout: 10000 })
  await bob.locator('.chat-head h2', { hasText: new RegExp(`^${escapeRe(UGROUP2)}$`) }).waitFor({ timeout: 5000 })
  if (await roomItem(bob, UGROUP).count()) throw new Error('Bob vẫn thấy tên cũ')
  await alice.locator('.chat-head h2', { hasText: new RegExp(`^${escapeRe(UGROUP2)}$`) }).waitFor({ timeout: 5000 })
  if ((await myRoom(bobToken, ugroupId))?.name !== UGROUP2) throw new Error('GET /rooms của Bob chưa có tên mới')

  // Thêm Dave.
  dave = await openUserPage('dave', DAVE, DAVE_PW)
  await roomItem(dave, GROUP_DAVE).waitFor({ timeout: 10000 })
  if (await roomItem(dave, UGROUP2).count()) throw new Error('Dave thấy nhóm trước khi được thêm')
  await markPage(dave)
  await groupPanel(alice).getByLabel('Thêm thành viên').fill(DAVE.fullName)
  await groupPanel(alice).getByRole('button', { name: new RegExp(`^${escapeRe(DAVE.fullName)}`) }).click()
  await waitUntil(async () => (await panelNames(alice)).includes(DAVE.fullName), 5000, 'Dave có trong danh sách thành viên')
  await roomItem(dave, UGROUP2).waitFor({ timeout: 10000 })
  await notReloaded(dave, 'Dave')
  await holdsFor(async () => (await roomItem(dave, UGROUP2).locator('.unread-badge').count()) === 0, 2000, 'Dave có huy hiệu chưa đọc cho tin cũ')
  if ((await myRoom(daveToken, ugroupId))?.unread_count !== 0) throw new Error('GET /rooms của Dave có unread_count khác 0')
  await openRoom(dave, UGROUP2)
  await bubbles(dave, 'chào nhóm liên chi nhánh').waitFor({ timeout: 5000 })

  // Carol đang mở nhóm và có thêm một WebSocket riêng: đối chứng là nhận được tin trước khi bị gỡ.
  carolBot = await openBot(carolToken)
  await send(alice, 'trước khi gỡ Carol')
  await confirmedId(alice, 'trước khi gỡ Carol')
  await bubbles(carol, 'trước khi gỡ Carol').waitFor({ timeout: 5000 })
  await waitUntil(() => carolBot.frames.some((f) => f.data.type === 'message' && f.data.message?.body === 'trước khi gỡ Carol'), 5000, 'WebSocket của Carol nhận tin trước khi bị gỡ')

  // Gỡ Carol chỉ bằng bàn phím: Tab tới nút "Gỡ", Enter (hộp xác nhận được chấp nhận).
  const removeLabel = `Gỡ ${CAROL.fullName} khỏi nhóm`
  await groupPanel(alice).getByLabel('Tên nhóm', { exact: true }).focus()
  let tabs = 0
  while ((await alice.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== removeLabel) {
    if (++tabs > 40) throw new Error('không Tab tới được nút gỡ Carol')
    await alice.keyboard.press('Tab')
  }
  const confirmsBefore = acceptedConfirms.length
  await alice.keyboard.press('Enter')
  await waitUntil(async () => !(await panelNames(alice)).includes(CAROL.fullName), 5000, 'Carol rời danh sách thành viên')
  if (!acceptedConfirms.slice(confirmsBefore).some((m) => m.startsWith(`alice: Gỡ ${CAROL.fullName} khỏi nhóm`))) throw new Error('không có hộp xác nhận gỡ Carol')
  await alice.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const focus = await alice.evaluate(() => {
    const el = document.activeElement
    return { inside: !!el && el !== document.body && !!el.closest('[role="dialog"]'), label: el?.getAttribute('aria-label') ?? el?.tagName }
  })
  if (!focus.inside) throw new Error(`focus rơi ra ngoài hộp thoại sau khi gỡ: ${focus.label}`)

  // Carol mất nhóm ngay; trang đang mở nhóm báo không còn trong đó.
  await waitUntil(async () => (await roomItem(carol, UGROUP2).count()) === 0, 10000, 'nhóm biến mất khỏi danh sách của Carol')
  await carol.getByText(NOT_IN_ROOM).waitFor({ timeout: 5000 })
  await notReloaded(carol, 'Carol')
  await expectStatus('GET', `/rooms/${ugroupId}/messages`, carolToken, undefined, 404, 'room_not_found', 'Carol đọc tin')
  await expectStatus('GET', `/rooms/${ugroupId}/members`, carolToken, undefined, 404, 'room_not_found', 'Carol xem thành viên')
  const sendBack = await carolBot.attempt(ugroupId, 'Carol cố gửi sau khi bị gỡ')
  if (sendBack.type !== 'error' || sendBack.code !== 'room_not_found') throw new Error('Carol gửi qua WS: ' + JSON.stringify(sendBack))
  const cut = Date.now()
  await send(alice, 'sau khi gỡ Carol')
  await confirmedId(alice, 'sau khi gỡ Carol')
  await bubbles(bob, 'sau khi gỡ Carol').waitFor({ timeout: 5000 })
  await sleep(1500)
  const leaked = carolBot.frames.filter((f) => f.at >= cut && (f.data.room_id === ugroupId || f.data.message?.room_id === ugroupId))
  if (leaked.length) throw new Error('WebSocket của Carol vẫn nhận sự kiện của nhóm: ' + JSON.stringify(leaked[0].data))
  if (await bubbles(carol, 'sau khi gỡ Carol').count()) throw new Error('trang của Carol hiện tin sau khi bị gỡ')
  const history = await must('GET', `/rooms/${ugroupId}/messages?limit=50`, bobToken)
  if (history.items.some((m) => m.body === 'Carol cố gửi sau khi bị gỡ')) throw new Error('tin Carol gửi sau khi bị gỡ vẫn được lưu')

  await alice.keyboard.press('Escape')
  await groupPanel(alice).waitFor({ state: 'detached', timeout: 3000 })
  return `${tabs} lần Tab, focus sau khi gỡ: ${focus.label}`
})
carolBot?.close()

await step('21. Quyền: Bob (thành viên) không thấy điều khiển quản lý; đổi tên/thêm/gỡ/giải tán bằng token của Bob -> 403, Carol (đã bị gỡ) -> 404', async () => {
  await openRoom(bob, UGROUP2)
  await openPanel(bob)
  await waitUntil(async () => {
    const names = await panelNames(bob)
    return names.length === 3 && names.includes(ALICE.fullName) && names.includes(DAVE.fullName)
  }, 5000, 'bảng của Bob tải xong 3 thành viên')
  if (!(await panelMembers(bob).filter({ hasText: ALICE.fullName }).getByText('Chủ nhóm').count())) throw new Error('không ghi Alice là chủ nhóm')
  const c = await managerControls(bob)
  if (Object.values(c).some((n) => n !== 0)) throw new Error('thành viên thường thấy điều khiển quản lý: ' + JSON.stringify(c))
  if (!(await groupPanel(bob).getByRole('button', { name: 'Rời nhóm' }).isVisible())) throw new Error('không có nút "Rời nhóm"')

  await expectStatus('PATCH', `/rooms/${ugroupId}`, bobToken, { name: 'Bob đổi tên' }, 403, 'forbidden', 'Bob đổi tên')
  await expectStatus('POST', `/rooms/${ugroupId}/members`, bobToken, { user_id: carolId }, 403, 'forbidden', 'Bob thêm thành viên')
  await expectStatus('DELETE', `/rooms/${ugroupId}/members/${daveId}`, bobToken, undefined, 403, 'forbidden', 'Bob gỡ thành viên')
  await expectStatus('DELETE', `/rooms/${ugroupId}`, bobToken, undefined, 403, 'forbidden', 'Bob giải tán')
  await expectStatus('PATCH', `/rooms/${ugroupId}`, carolToken, { name: 'Carol đổi tên' }, 404, 'room_not_found', 'Carol (ngoài nhóm) đổi tên')
  const after = await myRoom(aliceToken, ugroupId)
  if (after?.name !== UGROUP2 || after.member_count !== 3) throw new Error('nhóm bị đổi sau các yêu cầu bị từ chối: ' + JSON.stringify(after))
  // Bảng của Bob để mở cho bước sau: chuyển quyền phải hiện ngay, không cần mở lại.
})

await step('22. Chủ nhóm Alice rời -> Bob thành chủ (bảng đang mở hiện điều khiển ngay, my_role=owner); Alice không còn thấy nhóm', async () => {
  await openRoom(alice, UGROUP2)
  await openPanel(alice)
  const confirmsBefore = acceptedConfirms.length
  await groupPanel(alice).getByRole('button', { name: 'Rời nhóm' }).click()
  await alice.waitForURL(BASE + '/', { timeout: 10000 })
  if (!acceptedConfirms.slice(confirmsBefore).some((m) => m.startsWith('alice: Bạn là chủ nhóm'))) throw new Error('Alice không được cảnh báo chuyển quyền')
  await waitUntil(async () => (await roomItem(alice, UGROUP2).count()) === 0, 10000, 'nhóm biến mất khỏi danh sách của Alice')
  if (await groupPanel(alice).count()) throw new Error('bảng của Alice vẫn mở')

  await groupPanel(bob).getByRole('button', { name: 'Giải tán nhóm' }).waitFor({ timeout: 10000 })
  const c = await managerControls(bob)
  if (c.name !== 1 || c.add !== 1 || c.dissolve !== 1) throw new Error('Bob (chủ mới) thiếu điều khiển: ' + JSON.stringify(c))
  await waitUntil(async () => {
    const names = await panelNames(bob)
    return names.length === 2 && !names.includes(ALICE.fullName)
  }, 5000, 'bảng của Bob bỏ Alice')
  if (!(await panelMembers(bob).filter({ hasText: BOB.fullName }).getByText('Chủ nhóm').count())) throw new Error('Bob không được ghi là chủ nhóm')
  if ((await managerControls(bob)).remove !== 1) throw new Error('Bob không gỡ được Dave (thiếu nút "Gỡ")')

  if ((await myRoom(bobToken, ugroupId))?.my_role !== 'owner') throw new Error('GET /rooms: my_role của Bob không phải owner')
  if ((await myRoom(daveToken, ugroupId))?.my_role !== 'member') throw new Error('GET /rooms: my_role của Dave không phải member')
  const roles = Object.fromEntries((await must('GET', `/rooms/${ugroupId}/members`, bobToken)).map((m) => [m.user_id, m.role]))
  if (roles[bobId] !== 'owner' || roles[daveId] !== 'member' || aliceId in roles) throw new Error('vai trò sau khi Alice rời: ' + JSON.stringify(roles))
  if (await myRoom(aliceToken, ugroupId)) throw new Error('GET /rooms của Alice vẫn có nhóm')
  await expectStatus('GET', `/rooms/${ugroupId}/messages`, aliceToken, undefined, 404, 'room_not_found', 'Alice đọc tin sau khi rời')
})

await step('23. Giải tán: Bob gõ sai tên -> nút tắt, đúng -> nhóm mất ngay với Dave; admin thấy ở "Đã lưu trữ", khôi phục -> Bob và Dave thấy lại cùng tin nhắn', async () => {
  await openRoom(dave, UGROUP2)
  const panel = groupPanel(bob)
  const box = panel.getByLabel('Gõ tên nhóm để xác nhận giải tán')
  const btn = panel.getByRole('button', { name: 'Giải tán nhóm' })
  for (const wrong of [UGROUP2.toUpperCase(), UGROUP2.slice(0, -1), ` ${UGROUP2}`]) {
    await box.fill(wrong)
    if (await btn.isEnabled()) throw new Error(`nút bật khi gõ sai: "${wrong}"`)
  }
  await box.fill(UGROUP2)
  if (!(await btn.isEnabled())) throw new Error('nút vẫn tắt khi gõ đúng tên')
  await btn.click()
  await bob.waitForURL(BASE + '/', { timeout: 10000 })
  await waitUntil(async () => (await roomItem(bob, UGROUP2).count()) === 0, 10000, 'nhóm biến mất khỏi danh sách của Bob')
  await waitUntil(async () => (await roomItem(dave, UGROUP2).count()) === 0, 10000, 'nhóm biến mất khỏi danh sách của Dave')
  await dave.getByText(NOT_IN_ROOM).waitFor({ timeout: 5000 })
  await notReloaded(dave, 'Dave')
  await expectStatus('GET', `/rooms/${ugroupId}/messages`, daveToken, undefined, 404, 'room_not_found', 'Dave đọc tin nhóm đã giải tán')
  await expectStatus('GET', `/rooms/${ugroupId}/messages`, bobToken, undefined, 404, 'room_not_found', 'Bob đọc tin nhóm đã giải tán')

  const ctx = await browser.newContext(desktop)
  const admin = await ctx.newPage()
  pages.admin = admin
  watch(admin, 'admin')
  try {
    await login(admin, ADMIN_USER, ADMIN_PW)
    await admin.getByText('Xin chào,').waitFor({ timeout: 10000 })
    await admin.goto(BASE + '/admin/rooms')
    await admin.getByRole('heading', { name: 'Phòng và nhóm' }).waitFor({ timeout: 10000 })
    await admin.getByRole('tab', { name: 'Đã lưu trữ' }).click()
    await admin.getByLabel('Tìm nhóm').fill(UGROUP2)
    const row = admin.locator('.table-row', { hasText: UGROUP2 })
    await row.waitFor({ timeout: 10000 })
    await row.getByText(/Xoá vĩnh viễn sau/).waitFor({ timeout: 5000 })
    for (const secret of ['chào nhóm liên chi nhánh', 'sau khi gỡ Carol']) {
      if ((await admin.content()).includes(secret)) throw new Error('trang admin chứa nội dung tin: ' + secret)
    }
    await admin.getByRole('button', { name: `Khôi phục ${UGROUP2}` }).click()
    await waitUntil(async () => (await row.count()) === 0, 10000, 'nhóm rời tab Đã lưu trữ')
  } finally {
    delete pages.admin
    await ctx.close()
  }

  for (const [page, who] of [[bob, 'Bob'], [dave, 'Dave']]) {
    await roomItem(page, UGROUP2).waitFor({ timeout: 10000 })
    await notReloaded(page, who)
    await openRoom(page, UGROUP2)
    await bubbles(page, 'chào nhóm liên chi nhánh').waitFor({ timeout: 10000 })
    await bubbles(page, 'sau khi gỡ Carol').waitFor({ timeout: 10000 })
  }
  if ((await myRoom(bobToken, ugroupId))?.my_role !== 'owner') throw new Error('sau khôi phục Bob không còn là chủ nhóm')
  if (await myRoom(aliceToken, ugroupId)) throw new Error('Alice (đã rời) thấy lại nhóm sau khôi phục')
})

await step('24. Giới hạn MAX_OWNED_GROUPS=3: nhóm thứ 4 -> 409 too_many_groups (REST) và thông báo tiếng Việt trong hộp thoại; giải tán một nhóm thì tạo lại được', async () => {
  const owned = async () => (await must('GET', '/rooms', carolToken)).filter((r) => r.my_role === 'owner')
  if ((await owned()).length !== 0) throw new Error('Carol đã là chủ nhóm từ trước')
  // Preflight: stack phải đặt MAX_OWNED_GROUPS=3, nếu không các bước dưới sai khó hiểu. Tạo tới khi bị 409 rồi giải tán hết.
  const probe = []
  let probeStatus = 0
  for (let i = 1; i <= 8 && probeStatus !== 409; i++) {
    const r = await http('POST', '/rooms/group', carolToken, { name: `UI dò giới hạn ${i} ${TAG}`, member_ids: [] })
    probeStatus = r.status
    if (r.status === 201) probe.push(r.data.id)
    else if (r.status !== 409 || r.data?.detail !== 'too_many_groups') throw new Error(`dò giới hạn: POST /rooms/group -> ${r.status} ${JSON.stringify(r.data)}`)
  }
  for (const id of probe) await must('DELETE', `/rooms/${id}`, carolToken, undefined, [204])
  if (probe.length !== 3) throw new Error(`Stack đang cho phép ${probe.length} nhóm mỗi chủ; scripts/e2e_chat_ui.mjs cần MAX_OWNED_GROUPS=3 trong .env (rồi docker compose up -d --build)`)
  const ids = []
  for (let i = 1; i <= 3; i++) ids.push((await must('POST', '/rooms/group', carolToken, { name: `UI giới hạn ${i} ${TAG}`, member_ids: [daveId] }, [201])).id)
  await expectStatus('POST', '/rooms/group', carolToken, { name: `UI giới hạn 4 ${TAG}`, member_ids: [] }, 409, 'too_many_groups', 'nhóm thứ 4 qua REST')
  if ((await owned()).length !== 3) throw new Error(`Carol làm chủ ${(await owned()).length} nhóm (mong đợi 3)`)

  const name4 = `UI giới hạn 4 qua giao diện ${TAG}`
  await carol.getByRole('button', { name: 'Cuộc trò chuyện mới' }).click()
  const dialog = carol.getByRole('dialog', { name: 'Cuộc trò chuyện mới' })
  await dialog.getByRole('tab', { name: 'Tạo nhóm' }).click()
  await dialog.getByLabel('Tên nhóm').fill(name4)
  const createBtn = dialog.getByRole('button', { name: 'Tạo nhóm', exact: true })
  const urlBefore = carol.url()
  await createBtn.click()
  await dialog.getByRole('alert').filter({ hasText: 'Bạn đang quản lý quá nhiều nhóm. Hãy giải tán bớt.' }).waitFor({ timeout: 5000 })
  if (carol.url() !== urlBefore) throw new Error('Carol bị điều hướng dù tạo nhóm thất bại: ' + carol.url())
  await waitUntil(() => createBtn.isEnabled(), 3000, 'nút "Tạo nhóm" bật lại sau lỗi')
  if ((await must('GET', '/rooms', carolToken)).some((r) => r.name === name4)) throw new Error('nhóm vượt giới hạn vẫn được tạo')

  // Nhóm đã giải tán (lưu trữ) không tính vào giới hạn.
  await must('DELETE', `/rooms/${ids[0]}`, carolToken, undefined, [204])
  await createBtn.click()
  await carol.waitForURL(/\/chat\/\d+$/, { timeout: 10000 })
  await carol.locator('.chat-head h2', { hasText: new RegExp(`^${escapeRe(name4)}$`) }).waitFor({ timeout: 10000 })
  if ((await owned()).length !== 3) throw new Error(`sau khi tạo lại Carol làm chủ ${(await owned()).length} nhóm`)
})

// ---------------- trả lời, @nhắc tên, @all, thông báo trình duyệt ----------------

/** Access token sống 15 phút: lấy lại trước các bước dùng REST/WS thô ở cuối script. */
async function refreshTokens() {
  adminToken = await restReady(ADMIN_USER, ADMIN_PW)
  aliceToken = await restReady(ALICE.username, ALICE_PW)
  bobToken = await restReady(BOB.username, BOB_PW)
  carolToken = await restReady(CAROL.username, CAROL_PW)
}

const msgById = (page, id) => msgList(page).locator(`.msg[data-message-id="${id}"]`)
const quoteIn = (page, text) => bubbles(page, text).locator('.quote')
const picker = (page) => page.getByRole('listbox', { name: 'Gợi ý nhắc tên' })
const pickerOptions = (page) => picker(page).getByRole('option').allInnerTexts()
const mentionBadge = (page, name) => roomItem(page, name).locator('.mention-badge')
const unreadNumber = (page, name) => roomItem(page, name).locator('.unread-badge:not(.mention-badge)')
const sentFrames = (who, body) => clientFrames[who].filter((f) => f.body === body)
const hasClass = async (locator, cls) => ((await locator.getAttribute('class')) ?? '').split(/\s+/).includes(cls)

async function roomMessages(token, roomId) {
  return (await must('GET', `/rooms/${roomId}/messages?limit=100`, token)).items
}
async function storedMessage(token, roomId, body) {
  const found = (await roomMessages(token, roomId)).filter((m) => m.body === body)
  if (found.length !== 1) throw new Error(`máy chủ có ${found.length} tin "${body}" (mong đợi 1)`)
  return found[0]
}

/** Bong bóng tin `id` có nằm trong khung nhìn của danh sách tin không. */
const inView = (page, id) =>
  msgList(page).evaluate((el, mid) => {
    const b = el.querySelector(`.msg[data-message-id="${mid}"] .bubble`)
    if (!b) return false
    const r = b.getBoundingClientRect()
    const l = el.getBoundingClientRect()
    return r.bottom > l.top + 4 && r.top < l.bottom - 4
  }, id)

await refreshTokens()

await step('25. Trả lời: Bob trả lời tin của Alice trong nhóm; Alice thấy trích dẫn đúng, bấm thì cuộn tới tin gốc và nháy; xoá gốc thì trích dẫn của Bob đổi ngay; reply_to_id phòng khác/đã xoá qua WS -> invalid_reply', async () => {
  const ORIGINAL = `gốc để trả lời ${TAG}`
  const REPLY = `đây là câu trả lời ${TAG}`
  await openRoom(alice, GROUP)
  await openRoom(bob, GROUP)
  await send(alice, ORIGINAL)
  const originalId = await confirmedId(alice, ORIGINAL)
  await msgById(bob, originalId).waitFor({ timeout: 5000 })
  // Đẩy tin gốc ra khỏi khung nhìn (vẫn nằm trong trang đã tải) để bấm trích dẫn thật sự phải cuộn.
  await botSendMany(carolToken, group.id, Array.from({ length: 20 }, (_, i) => `tin đệm sau tin gốc #${i + 1}#`))
  await bubbles(bob, 'tin đệm sau tin gốc #20#').waitFor({ timeout: 10000 })
  await bubbles(alice, 'tin đệm sau tin gốc #20#').waitFor({ timeout: 10000 })

  // Nút "Trả lời" nằm ngoài luồng và chỉ hiện khi rê chuột/focus vào tin.
  const target = msgById(bob, originalId)
  await target.hover()
  await target.getByRole('button', { name: 'Trả lời' }).click()
  const bar = bob.locator('.reply-bar [role="status"]')
  await waitUntil(async () => (await bar.innerText()).trim() === `Đang trả lời ${ALICE.fullName}: ${ORIGINAL}`, 3000, 'thanh "Đang trả lời <Alice>: <tin gốc>"')
  if ((await bob.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== 'Nhập tin nhắn') throw new Error('focus không về ô soạn sau khi bấm "Trả lời"')
  await bob.keyboard.type(REPLY)
  await bob.keyboard.press('Enter')
  const replyId = await confirmedId(bob, REPLY)
  if (await bob.locator('.reply-bar').count()) throw new Error('thanh trả lời không đóng sau khi gửi')
  const frame = sentFrames('bob', REPLY)[0]
  if (frame?.reply_to_id !== originalId) throw new Error('frame send của Bob: reply_to_id=' + frame?.reply_to_id)
  const stored = await storedMessage(carolToken, group.id, REPLY)
  if (stored.reply_to?.id !== originalId || stored.reply_to.sender_id !== aliceId || stored.reply_to.deleted || stored.reply_to.snippet !== ORIGINAL) throw new Error('REST reply_to: ' + JSON.stringify(stored.reply_to))

  // Alice thấy khối trích dẫn đúng tên và nội dung.
  const quote = quoteIn(alice, REPLY)
  await quote.waitFor({ timeout: 5000 })
  const qName = (await quote.locator('.quote-name').innerText()).trim()
  const qText = (await quote.locator('.quote-text').innerText()).trim()
  if (qName !== ALICE.fullName || qText !== ORIGINAL) throw new Error(`trích dẫn "${qName}: ${qText}"`)
  await settle(alice)
  if (await inView(alice, originalId)) throw new Error('tin gốc đã nằm trong khung nhìn trước khi bấm (không kiểm được việc cuộn)')
  const original = msgById(alice, originalId)
  if (await hasClass(original, 'msg-flash')) throw new Error('tin gốc nháy trước khi bấm')
  await quote.click() // khối trích dẫn là nút "Đến tin được trả lời"
  await waitUntil(() => hasClass(original, 'msg-flash'), 2000, 'tin gốc có lớp msg-flash')
  await waitUntil(() => inView(alice, originalId), 3000, 'tin gốc được cuộn vào khung nhìn')
  const t0 = Date.now()
  await waitUntil(async () => !(await hasClass(original, 'msg-flash')), 5000, 'lớp msg-flash mất')
  const flashMs = Date.now() - t0

  // Alice xoá tin gốc: trích dẫn trên trang Bob (đã tải sẵn) chuyển thành "Tin nhắn đã bị xoá", không tải lại.
  await markPage(bob)
  await original.getByRole('button', { name: 'Xoá tin nhắn' }).click()
  const bobQuote = quoteIn(bob, REPLY)
  await bobQuote.getByText('Tin nhắn đã bị xoá').waitFor({ timeout: 5000 })
  if ((await bobQuote.innerText()).includes(ORIGINAL)) throw new Error('trích dẫn của Bob vẫn lộ nội dung tin đã xoá')
  if ((await bobQuote.locator('.quote-name').innerText()).trim() !== ALICE.fullName) throw new Error('trích dẫn mất tên người gửi')
  await quoteIn(alice, REPLY).getByText('Tin nhắn đã bị xoá').waitFor({ timeout: 5000 })
  await notReloaded(bob, 'Bob')
  const after = await storedMessage(carolToken, group.id, REPLY)
  if (!after.reply_to?.deleted || after.reply_to.snippet !== '') throw new Error('REST reply_to sau khi xoá: ' + JSON.stringify(after.reply_to))

  // WS thô bằng token Bob: trả lời tin của phòng khác / tin đã xoá -> invalid_reply, không tạo tin.
  const bobBot = await openBot(bobToken)
  try {
    const foreign = (await roomMessages(bobToken, directRoomId)).filter((m) => !m.deleted).at(-1)
    if (!foreign) throw new Error('phòng 1-1 không có tin để thử')
    const bad = [[`trả lời chéo phòng ${TAG}`, foreign.id], [`trả lời tin đã xoá ${TAG}`, originalId]]
    for (const [body, rid] of bad) {
      const r = await bobBot.attempt(group.id, body, { reply_to_id: rid })
      if (r.type !== 'error' || r.code !== 'invalid_reply') throw new Error(`${body}: ${JSON.stringify(r)}`)
    }
    const ok = await bobBot.send(group.id, `trả lời hợp lệ qua WS ${TAG}`, { reply_to_id: replyId }) // đối chứng
    if (ok.reply_to?.id !== replyId) throw new Error('đối chứng: reply_to=' + JSON.stringify(ok.reply_to))
    const bodies = (await roomMessages(carolToken, group.id)).map((m) => m.body)
    const leaked = bad.filter(([body]) => bodies.includes(body))
    if (leaked.length) throw new Error('máy chủ vẫn lưu tin trả lời không hợp lệ: ' + leaked[0][0])
  } finally {
    bobBot.close()
  }
  return `nháy ${flashMs}ms`
})

await step('26. @nhắc tên: Alice gõ "@" có gợi ý, gõ "quoc" (không dấu) lọc ra Bob, Enter chèn tên KHÔNG gửi; Bob (ở phòng khác) thấy "@" và số chưa đọc, mở phòng thì tin nổi bật, "@" mất; xoá chữ @Tên thì mentions=[]', async () => {
  await openRoom(bob, ALICE.fullName)
  await openRoom(alice, GROUP)
  await waitUntil(async () => (await myRoom(bobToken, group.id))?.unread_count === 0, 5000, 'Bob không còn tin chưa đọc ở nhóm trước khi thử')
  const box = alice.getByLabel('Nhập tin nhắn')
  await box.fill('')
  await box.pressSequentially('@')
  await picker(alice).waitFor({ timeout: 3000 })
  const all = await pickerOptions(alice)
  if (!all.some((t) => t.includes(BOB.fullName)) || !all.some((t) => t.includes(CAROL.fullName))) throw new Error('gợi ý thiếu Bob/Carol: ' + JSON.stringify(all))
  if (all.some((t) => t.includes(ALICE.fullName))) throw new Error('gợi ý có chính Alice')
  await box.pressSequentially('quoc')
  await waitUntil(async () => {
    const o = await pickerOptions(alice)
    return o.length === 1 && o[0].includes(BOB.fullName)
  }, 3000, 'gợi ý chỉ còn Bob khi gõ "quoc"')
  const lastBefore = (await roomMessages(aliceToken, group.id)).at(-1).id
  const framesBefore = clientFrames.alice.length
  await box.press('Enter')
  await waitUntil(async () => (await box.inputValue()) === `@${BOB.fullName} `, 2000, 'Enter chèn "@<tên Bob> "')
  await waitUntil(async () => (await picker(alice).count()) === 0, 2000, 'gợi ý đóng sau khi chọn')
  await sleep(1000)
  if (clientFrames.alice.length !== framesBefore) throw new Error('Enter lúc chọn gợi ý đã gửi tin')
  if ((await roomMessages(aliceToken, group.id)).at(-1).id !== lastBefore) throw new Error('máy chủ có tin mới sau Enter chọn gợi ý')

  const TEXT = `xem giúp tài liệu ${TAG}`
  const BODY = `@${BOB.fullName} ${TEXT}`
  await box.pressSequentially(TEXT)
  await box.press('Enter')
  const id = await confirmedId(alice, TEXT)
  const frame = sentFrames('alice', BODY)[0]
  if (JSON.stringify(frame?.mentions) !== JSON.stringify([bobId])) throw new Error('frame send: mentions=' + JSON.stringify(frame?.mentions))
  const stored = await storedMessage(aliceToken, group.id, BODY)
  if (stored.mentions.length !== 1 || stored.mentions[0].user_id !== bobId || stored.mention_all) throw new Error('REST: ' + JSON.stringify(stored.mentions))
  const aliceBubble = msgById(alice, id)
  if ((await aliceBubble.locator('.mention').innerText()).trim() !== `@${BOB.fullName}`) throw new Error('Alice không thấy chữ nhắc tên nổi bật')
  if (await aliceBubble.locator('.msg-mentions-me').count()) throw new Error('tin của chính Alice bị đánh dấu nhắc Alice')

  // Bob đang ở phòng 1-1: thấy "@" và số chưa đọc 1 ở nhóm.
  await waitUntil(async () => (await mentionBadge(bob, GROUP).count()) === 1 && (await unreadNumber(bob, GROUP).count()) === 1 && (await unreadNumber(bob, GROUP).innerText()).trim() === '1', 10000, 'Bob thấy "@" và "1" ở nhóm')
  if ((await myRoom(bobToken, group.id))?.unread_mentions !== 1) throw new Error('REST unread_mentions của Bob khác 1')
  await openRoom(bob, GROUP)
  const bobBubble = msgById(bob, id)
  await bobBubble.locator('.bubble.msg-mentions-me').waitFor({ timeout: 5000 })
  if ((await bobBubble.locator('.mention').innerText()).trim() !== `@${BOB.fullName}`) throw new Error('Bob không thấy chữ nhắc tên')
  await waitUntil(async () => (await roomItem(bob, GROUP).locator('.unread-badge').count()) === 0, 5000, '"@" và số chưa đọc mất khi Bob mở nhóm')
  await waitUntil(async () => (await myRoom(bobToken, group.id))?.unread_mentions === 0, 5000, 'REST unread_mentions của Bob về 0')

  // Chọn Bob rồi xoá chữ "@Tên": tin gửi đi không kèm mention.
  await box.pressSequentially('@quoc')
  await waitUntil(async () => (await pickerOptions(alice)).length === 1, 3000, 'gợi ý Bob lần hai')
  await box.press('Enter')
  const TEXT2 = `đọc nhé ${TAG}`
  await box.pressSequentially(TEXT2)
  await box.press('Home')
  for (let i = 0; i < Array.from(`@${BOB.fullName} `).length; i++) await box.press('Delete')
  if ((await box.inputValue()) !== TEXT2) throw new Error('ô soạn sau khi xoá tên: ' + (await box.inputValue()))
  await box.press('End')
  await box.press('Enter')
  await confirmedId(alice, TEXT2)
  const frame2 = sentFrames('alice', TEXT2)[0]
  if (!frame2 || (frame2.mentions ?? []).length !== 0 || frame2.mention_all) throw new Error('frame send vẫn kèm mention: ' + JSON.stringify(frame2))
  const stored2 = await storedMessage(aliceToken, group.id, TEXT2)
  if (stored2.mentions.length !== 0 || stored2.mention_all) throw new Error('REST mentions=' + JSON.stringify(stored2.mentions))
})

await step('27. @all: "@all" đứng đầu gợi ý trong nhóm 3 người; "@all họp 9h" -> Bob và Carol (đang ở phòng khác) thấy "@" và viền nhắc tên, Alice thì không; chat 1-1 không có "@all"', async () => {
  await openRoom(bob, ALICE.fullName)
  if ((await carol.locator('.chat-head h2').innerText()).trim() === GROUP) throw new Error('Carol đang mở nhóm (cần ở phòng khác)')
  await openRoom(alice, GROUP)
  const box = alice.getByLabel('Nhập tin nhắn')
  await box.fill('')
  await box.pressSequentially('@')
  const first = picker(alice).getByRole('option').first()
  await first.waitFor({ timeout: 3000 })
  if (!(await first.innerText()).includes('@all') || (await first.getAttribute('aria-selected')) !== 'true') throw new Error('mục đầu tiên: ' + (await first.innerText()))
  await box.press('Enter')
  await waitUntil(async () => (await box.inputValue()) === '@all ', 2000, 'Enter chèn "@all "')
  const TEXT = `họp 9h ${TAG}`
  await box.pressSequentially(TEXT)
  await box.press('Enter')
  const id = await confirmedId(alice, TEXT)
  const frame = sentFrames('alice', `@all ${TEXT}`)[0]
  if (frame?.mention_all !== true) throw new Error('frame send: mention_all=' + frame?.mention_all)
  if (!(await storedMessage(aliceToken, group.id, `@all ${TEXT}`)).mention_all) throw new Error('REST: mention_all=false')
  if (await msgById(alice, id).locator('.msg-mentions-me').count()) throw new Error('tin @all của Alice viền nhắc chính Alice')
  if ((await msgById(alice, id).locator('.mention-all').innerText()).trim() !== '@all') throw new Error('Alice không thấy "@all" nổi bật')

  for (const [page, token, who] of [[bob, bobToken, 'Bob'], [carol, carolToken, 'Carol']]) {
    await waitUntil(async () => (await mentionBadge(page, GROUP).count()) === 1, 10000, `${who} thấy "@" ở nhóm`)
    const room = await myRoom(token, group.id)
    if (room?.unread_mentions !== 1) throw new Error(`REST unread_mentions của ${who} = ${room?.unread_mentions}`)
  }
  await holdsFor(async () => (await mentionBadge(alice, GROUP).count()) === 0, 1500, 'Alice có "@" cho tin @all của chính mình')
  if ((await myRoom(aliceToken, group.id))?.unread_mentions !== 0) throw new Error('REST unread_mentions của Alice khác 0')
  for (const [page, who] of [[bob, 'Bob'], [carol, 'Carol']]) {
    await openRoom(page, GROUP)
    await msgById(page, id).locator('.bubble.msg-mentions-me').waitFor({ timeout: 5000 })
    await waitUntil(async () => (await mentionBadge(page, GROUP).count()) === 0, 5000, `"@" của ${who} mất khi mở nhóm`)
  }

  // Chat 1-1: có gợi ý Bob nhưng không có "@all".
  await openRoom(alice, BOB.fullName)
  await box.fill('')
  await box.pressSequentially('@')
  await picker(alice).waitFor({ timeout: 3000 })
  const opts = await pickerOptions(alice)
  if (opts.length !== 1 || !opts[0].includes(BOB.fullName)) throw new Error('gợi ý trong chat 1-1: ' + JSON.stringify(opts))
  await box.press('Escape')
  await box.fill('')
})

await step('28. @all phía máy chủ: mention_all=true mà không có chữ "@all" đứng riêng hoặc trong chat 1-1 -> lưu false; MENTION_ALL_PER_WINDOW=3: tin @all thứ 4 -> rate_limited, không có tin mới', async () => {
  const carolBot = await openBot(carolToken)
  const aliceBot = await openBot(aliceToken)
  try {
    const cases = [[carolBot, group.id, `không có chữ kia ${TAG}`], [carolBot, group.id, `@allo dính chữ ${TAG}`], [aliceBot, directRoomId, `@all trong chat 1-1 ${TAG}`]]
    for (const [bot, roomId, body] of cases) {
      const m = await bot.send(roomId, body, { mention_all: true })
      if (m.mention_all !== false) throw new Error(`"${body}": frame message mention_all=${m.mention_all}`)
      if ((await storedMessage(aliceToken, roomId, body)).mention_all !== false) throw new Error(`"${body}": REST mention_all=true`)
    }
    for (let i = 1; i <= 3; i++) {
      const m = await carolBot.send(group.id, `@all giới hạn ${i} ${TAG}`, { mention_all: true })
      if (m.mention_all !== true) throw new Error(`tin @all thứ ${i} không được nhận là @all`)
    }
    const r = await carolBot.attempt(group.id, `@all giới hạn 4 ${TAG}`, { mention_all: true })
    if (r.type !== 'error' || r.code !== 'rate_limited') throw new Error(`tin @all thứ 4: ${JSON.stringify(r)} (stack cần MENTION_ALL_PER_WINDOW=3 trong .env)`)
    if ((await roomMessages(aliceToken, group.id)).some((m) => m.body === `@all giới hạn 4 ${TAG}`)) throw new Error('tin @all vượt giới hạn vẫn được lưu')
    await carolBot.send(group.id, `tin thường sau giới hạn ${TAG}`) // giới hạn chỉ áp cho @all
  } finally {
    carolBot.close()
    aliceBot.close()
  }
})

// Chromium headless không đổi document.visibilityState khi chuyển tab (bringToFront) hay thu nhỏ cửa sổ, nên trạng thái
// "ẩn" được giả lập: __e2eSetHidden(true) đổi visibilityState/hidden/hasFocus rồi phát visibilitychange như trình duyệt thật.
// Notification và AudioContext được thay bằng bản ghi lại lời gọi; quyền vẫn đọc từ Notification thật (đã cấp quyền).
const NOTIFY_FAKE = () => {
  let hidden = false
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden })
  const realHasFocus = Document.prototype.hasFocus
  Document.prototype.hasFocus = function () {
    return hidden ? false : realHasFocus.call(this)
  }
  window.__e2eSetHidden = (value) => {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  }
  const RealNotification = window.Notification
  const notes = []
  window.__e2eNotes = notes
  class FakeNotification {
    constructor(title, options = {}) {
      notes.push({ title, body: options.body, tag: options.tag, silent: options.silent })
      this.onclick = null
    }
    close() {}
    static get permission() {
      return RealNotification.permission
    }
    static requestPermission(...args) {
      return RealNotification.requestPermission(...args)
    }
  }
  window.Notification = FakeNotification
  const beeps = []
  window.__e2eBeeps = beeps
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
    createOscillator() {
      const osc = { type: 'sine', frequency: { value: 0 }, connect() {}, start: () => beeps.push(osc.frequency.value), stop() {} }
      return osc
    }
    createGain() {
      return { gain: { value: 0 }, connect() {} }
    }
  }
  window.AudioContext = FakeAudioContext
  window.webkitAudioContext = FakeAudioContext
}

const notesOf = (page) => page.evaluate(() => window.__e2eNotes.slice())
const beepsOf = (page) => page.evaluate(() => window.__e2eBeeps.length)
const setHidden = (page, value) => page.evaluate((v) => window.__e2eSetHidden(v), value)
const counters = async (page) => ({ n: (await notesOf(page)).length, b: await beepsOf(page) })
/** Âm báo cách nhau tối thiểu 1,5 giây: chờ qua khoảng đó để "không có tiếng" không bị che bởi giới hạn này. */
const quiet = () => sleep(1700)

async function expectNotification(page, before, expected, what) {
  await waitUntil(async () => (await notesOf(page)).length > before.n, 8000, `${what}: có thông báo`)
  await sleep(1500) // bắt thông báo trùng tới muộn
  const list = (await notesOf(page)).slice(before.n)
  if (list.length !== 1) throw new Error(`${what}: ${list.length} thông báo (mong đợi 1): ${JSON.stringify(list.map((n) => n.tag))}`)
  for (const key of ['title', 'body', 'tag']) {
    if (list[0][key] !== expected[key]) throw new Error(`${what}: ${key}="${list[0][key]}" (mong đợi "${expected[key]}")`)
  }
  const beeps = (await beepsOf(page)) - before.b
  if (beeps !== 1) throw new Error(`${what}: ${beeps} tiếng báo (mong đợi 1)`)
}

async function expectSilence(page, before, arrived, what) {
  await waitUntil(arrived, 8000, `${what}: tin tới trang`)
  await holdsFor(async () => {
    const now = await counters(page)
    return now.n === before.n && now.b === before.b
  }, 2500, `${what}: có thông báo/tiếng báo`)
}

async function openNotifySettings(page) {
  await page.getByRole('button', { name: 'Cài đặt thông báo' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cài đặt thông báo' })
  await dialog.waitFor({ timeout: 5000 })
  return dialog
}
async function closeNotifySettings(dialog) {
  await dialog.getByRole('button', { name: 'Đóng' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 3000 })
}
async function setSwitch(dialog, name, value) {
  const sw = dialog.getByRole('switch', { name })
  if ((await sw.getAttribute('aria-checked')) !== String(value)) await sw.click()
  await waitUntil(async () => (await sw.getAttribute('aria-checked')) === String(value), 2000, `"${name}" = ${value}`)
}

await step('29. Bật thông báo (Notification/AudioContext giả lập, đã cấp quyền): mặc định tắt; "Thông báo trình duyệt" bật được và lưu localStorage; "Gửi thử" tạo đúng một thông báo và một tiếng', async () => {
  await bobCtx.grantPermissions(['notifications'], { origin: BASE })
  await bobCtx.addInitScript(NOTIFY_FAKE)
  await bob.reload()
  await roomItem(bob, GROUP).waitFor({ timeout: 10000 })
  await waitUntil(async () => (await bob.locator('.conn-banner').count()) === 0, 10000, 'Bob kết nối lại sau khi tải lại trang')
  const env = await bob.evaluate(() => ({ fake: Array.isArray(window.__e2eNotes), permission: Notification.permission, secure: window.isSecureContext }))
  if (!env.fake || env.permission !== 'granted' || !env.secure) throw new Error('môi trường thông báo: ' + JSON.stringify(env))
  const dialog = await openNotifySettings(bob)
  const main = dialog.getByRole('switch', { name: 'Thông báo trình duyệt' })
  if ((await main.getAttribute('aria-checked')) !== 'false') throw new Error('thông báo bật sẵn (mặc định phải tắt)')
  if (!(await main.isEnabled())) throw new Error('công tắc bị khoá dù đã có quyền')
  if ((await dialog.getByRole('switch', { name: 'Âm báo' }).getAttribute('aria-checked')) !== 'true') throw new Error('âm báo mặc định không bật')
  await setSwitch(dialog, 'Thông báo trình duyệt', true)
  const before = await counters(bob)
  await dialog.getByRole('button', { name: 'Gửi thử' }).click()
  await expectNotification(bob, before, { title: 'Kết Nối', body: 'Đây là thông báo thử.', tag: 'kn-test' }, '"Gửi thử"')
  await closeNotifySettings(dialog)
  const saved = await bob.evaluate(() => { const k = Object.keys(localStorage).filter((x) => x.startsWith('kn.notify.v1.')); return k.length === 1 ? JSON.parse(localStorage.getItem(k[0])) : { keys: k } })
  if (!saved?.enabled || !saved.sound || !saved.showPreview || saved.allGroupMessages) throw new Error('cài đặt đã lưu: ' + JSON.stringify(saved))
})

await step('30. Thông báo: trang Bob ẩn -> tin 1-1 báo đúng một lần (tiêu đề, "Alice: …", tag kn-room-{id}) kèm một tiếng; tin nhóm thường không; nhắc tên/@all có; tiêu đề tab "(N) Kết Nối" rồi "Kết Nối"; đang xem phòng thì không; tắt "Hiện nội dung tin" -> "Tin nhắn mới"', async () => {
  await openRoom(bob, ALICE.fullName)
  await openRoom(alice, BOB.fullName)
  await setHidden(bob, true)
  if ((await bob.evaluate(() => [document.visibilityState, document.hasFocus()])).join() !== 'hidden,false') throw new Error('không giả lập được trạng thái ẩn')

  // 1-1 khi trang ẩn (đang mở đúng phòng đó).
  await quiet()
  let before = await counters(bob)
  const DM = `thông báo 1-1 ${TAG}`
  await send(alice, DM)
  await expectNotification(bob, before, { title: ALICE.fullName, body: `${ALICE.fullName}: ${DM}`, tag: `kn-room-${directRoomId}` }, 'tin 1-1 khi ẩn')

  // Tin nhóm thường: không.
  await openRoom(alice, GROUP)
  await quiet()
  before = await counters(bob)
  const PLAIN = `tin nhóm thường ${TAG}`
  await send(alice, PLAIN)
  await expectSilence(bob, before, async () => (await roomItem(bob, GROUP).innerText()).includes(PLAIN), 'tin nhóm thường')

  // Nhắc tên Bob, rồi @all: có.
  const aliceBot = await openBot(aliceToken)
  try {
    await quiet()
    before = await counters(bob)
    const MENTION = `@${BOB.fullName} nhắc khi ẩn ${TAG}`
    await aliceBot.send(group.id, MENTION, { mentions: [bobId] })
    await expectNotification(bob, before, { title: GROUP, body: `${ALICE.fullName}: ${MENTION}`, tag: `kn-room-${group.id}` }, 'tin nhắc tên Bob')
    await quiet()
    before = await counters(bob)
    const ALL = `@all thông báo khi ẩn ${TAG}`
    const m = await aliceBot.send(group.id, ALL, { mention_all: true })
    if (!m.mention_all) throw new Error('tin @all không được nhận là @all')
    await expectNotification(bob, before, { title: GROUP, body: `${ALICE.fullName}: ${ALL}`, tag: `kn-room-${group.id}` }, 'tin @all')
  } finally {
    aliceBot.close()
  }

  // Tiêu đề tab: tổng chưa đọc khớp GET /rooms, về "Kết Nối" khi đọc hết.
  const unreadRooms = async () => (await must('GET', '/rooms', bobToken)).filter((r) => r.unread_count > 0)
  let total = 0
  await waitUntil(async () => {
    total = (await unreadRooms()).reduce((s, r) => s + r.unread_count, 0)
    return total >= 4 && (await bob.title()) === `(${total}) Kết Nối`
  }, 8000, `tiêu đề tab "(N) Kết Nối" khớp GET /rooms`)
  const busyTitle = await bob.title()
  await setHidden(bob, false)
  for (const r of await unreadRooms()) if (r.id !== directRoomId) await openRoom(bob, r.name)
  await waitUntil(async () => (await bob.title()) === 'Kết Nối', 8000, 'tiêu đề tab về "Kết Nối"')
  await waitUntil(async () => (await unreadRooms()).length === 0, 8000, 'GET /rooms của Bob hết chưa đọc')

  // Đang xem đúng phòng, trang hiển thị và có tiêu điểm: không.
  await openRoom(bob, ALICE.fullName)
  if ((await bob.evaluate(() => [document.visibilityState, document.hasFocus()])).join() !== 'visible,true') throw new Error('trang Bob không ở trạng thái hiển thị/có tiêu điểm')
  await openRoom(alice, BOB.fullName)
  await quiet()
  before = await counters(bob)
  const SEEN = `tin khi đang xem ${TAG}`
  await send(alice, SEEN)
  await expectSilence(bob, before, async () => (await bubbles(bob, SEEN).count()) === 1, 'tin của phòng đang xem')

  // Tắt "Hiện nội dung tin": thông báo không mang nội dung.
  let dialog = await openNotifySettings(bob)
  await setSwitch(dialog, 'Hiện nội dung tin', false)
  await closeNotifySettings(dialog)
  await setHidden(bob, true)
  await quiet()
  before = await counters(bob)
  const SECRET = `nội dung riêng tư ${TAG}`
  await send(alice, SECRET)
  await expectNotification(bob, before, { title: ALICE.fullName, body: 'Tin nhắn mới', tag: `kn-room-${directRoomId}` }, 'tin khi tắt xem trước')
  if (JSON.stringify(await notesOf(bob)).includes(SECRET)) throw new Error('thông báo lộ nội dung khi đã tắt xem trước')
  await setHidden(bob, false)
  dialog = await openNotifySettings(bob)
  await setSwitch(dialog, 'Hiện nội dung tin', true)
  await closeNotifySettings(dialog)
  return `tiêu đề lúc ẩn "${busyTitle}"`
})

await step('31. Không báo tin bù: cắt WebSocket của Bob (trang ẩn), Alice nhắn 3 tin, nối lại -> Bob có đủ 3 tin nhưng không thông báo/tiếng nào; tin trực tiếp sau đó vẫn báo', async () => {
  await openRoom(bob, ALICE.fullName)
  await openRoom(alice, BOB.fullName)
  await setHidden(bob, true)
  await quiet()
  const before = await counters(bob)
  await setBobOffline(true)
  await waitUntil(() => bob.locator('.conn-banner').count(), 15000, 'Bob mất kết nối')
  const missed = [1, 2, 3].map((i) => `tin bù số ${i} ${TAG}`)
  for (const text of missed) {
    await send(alice, text)
    await confirmedId(alice, text)
  }
  await sleep(1000)
  if (await bubbles(bob, missed[0]).count()) throw new Error('Bob nhận tin khi đang mất kết nối?')
  await setBobOffline(false)
  for (const text of missed) await expectExactlyOnce(bob, text, 15000, `Bob nhận "${text}" sau khi nối lại`)
  await waitUntil(async () => (await bob.locator('.conn-banner').count()) === 0, 10000, 'Bob nối lại')
  await holdsFor(async () => {
    const now = await counters(bob)
    return now.n === before.n && now.b === before.b
  }, 3000, 'có thông báo/tiếng báo cho tin bù')

  await quiet()
  const live = await counters(bob)
  const LIVE = `tin trực tiếp sau khi nối lại ${TAG}`
  await send(alice, LIVE)
  await expectNotification(bob, live, { title: ALICE.fullName, body: `${ALICE.fullName}: ${LIVE}`, tag: `kn-room-${directRoomId}` }, 'tin trực tiếp sau khi nối lại')
})
await setBobOffline(false)

await step('32. Lần đầu liên hệ: Carol (chưa từng nhắn với Bob) mở chat 1-1 và nhắn -> Bob (trang ẩn) được báo cho phòng mới, phòng hiện ở thanh bên', async () => {
  if ((await must('GET', '/rooms', bobToken)).some((r) => r.type === 'direct' && r.peer_id === carolId)) throw new Error('Bob đã có chat 1-1 với Carol từ trước')
  await setHidden(bob, true)
  await quiet()
  const before = await counters(bob)
  const dm = await must('POST', '/rooms/direct', carolToken, { user_id: bobId })
  const FIRST = `lần đầu nhắn Huy ${TAG}`
  const carolBot = await openBot(carolToken)
  try {
    await carolBot.send(dm.id, FIRST)
  } finally {
    carolBot.close()
  }
  await expectNotification(bob, before, { title: CAROL.fullName, body: `${CAROL.fullName}: ${FIRST}`, tag: `kn-room-${dm.id}` }, 'tin đầu tiên của phòng 1-1 mới')
  await roomItem(bob, CAROL.fullName).waitFor({ timeout: 5000 })
  return `phòng #${dm.id}`
})
if (!bob.isClosed()) await setHidden(bob, false)
await refreshTokens()

for (const ctx of extraContexts) await ctx.close()
delete pages.carol
delete pages.dave

await step('33. Khoá ui.bob: trang của Bob về đăng nhập trong ~40 giây, không vòng lặp kết nối lại', async () => {
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

await step('34. Không có lỗi pageerror hay hộp thoại ngoài dự kiến', async () => {
  if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '))
  if (unexpectedDialogs.length) throw new Error('hộp thoại: ' + unexpectedDialogs.slice(0, 3).join(' | '))
})

await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
