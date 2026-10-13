# Kết Nối: app nhắn tin nội bộ

Thiết kế: `docs/superpowers/specs/2026-10-12-internal-messaging-design.md`

## Chạy lần đầu (dev hoặc server Ubuntu)

```bash
cp .env.example .env          # BẮT BUỘC sửa JWT_SECRET (openssl rand -hex 32) và mật khẩu DB (nên dùng openssl rand -hex 32)
docker compose up -d --build  # dev: tự dùng thêm docker-compose.override.yml (mở cổng DB/Redis ở localhost)
docker compose ps             # đợi các service healthy
```

Triển khai thật (không mở cổng DB/Redis ra ngoài):

```bash
docker compose -f docker-compose.yml up -d --build
```

## Giao diện web

Sau khi `docker compose up -d --build`, mở `http://<địa-chỉ-máy-chủ>/` trong trình duyệt. Đăng nhập bằng tài khoản admin tạo ở bước bên dưới; lần đầu hệ thống bắt đổi mật khẩu. Sau khi kéo mã nguồn mới về, hãy chạy lại `docker compose up -d --build` vì giao diện web được đóng gói sẵn trong image.

Phát triển giao diện (cần Node 22.4+; stack docker compose đang chạy để có API):

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, /api được proxy sang http://localhost:80
npm test         # chạy test (Vitest)
npm run build    # kiểm tra kiểu và build ra frontend/dist
```

## Giao diện chat

**Bố cục.** Cột trái là danh sách cuộc trò chuyện (nhóm và nhắn riêng, xếp theo hoạt động mới nhất, kèm tin cuối và số chưa đọc), ô "Lọc theo tên" và nút **"+ Mới"** với hai tab: "Nhắn riêng" (tìm đồng nghiệp theo tên hoặc tên đăng nhập rồi nhắn riêng) và "Tạo nhóm". Chân cột trái có lời chào, "Quản trị" (chỉ admin), "Thông báo" (cài đặt thông báo), "Đổi mật khẩu", "Đăng xuất". Cột phải là hội thoại đang mở với ô soạn tin ở dưới (Enter để gửi, Shift+Enter xuống dòng; Enter của bộ gõ tiếng Việt khi đang soạn chữ không gửi tin). Trên điện thoại (màn hình hẹp) chỉ hiện một trong hai: danh sách, hoặc hội thoại có nút "←" (Về danh sách).

**Hành vi.**
- Tin vừa gửi hiện ngay với trạng thái "Đang gửi…". Mất mạng thì tin chờ gửi và tự gửi lại khi kết nối có lại (mỗi tin có `client_id` nên không bao giờ bị lưu hai lần); quá 15 giây chưa gửi được thì hiện "Gửi lỗi" với nút "Thử lại"/"Bỏ". Trong lúc mất kết nối có dải "Đang kết nối lại…"; khi nối lại, tin bị lỡ được tải bù.
- Số chưa đọc cập nhật trực tiếp, không cần tải lại trang; mở phòng thì được đánh dấu đã đọc. Nhóm mới, thành viên thay đổi hay phòng nhắn riêng mới hiện ra ngay (sự kiện `rooms_changed`).
- Mở phòng thì nhảy tới tin mới nhất; cuộn lên đầu để tải thêm tin cũ (vị trí đang đọc giữ nguyên). Đang đọc tin cũ mà có tin mới thì hiện nút "↓ N tin mới" thay vì kéo xuống.
- Sửa ("(đã sửa)") và xoá ("Tin nhắn đã bị xoá", nội dung bị bỏ với mọi người) được với tin của chính mình.
- Tin nhắn chỉ là văn bản thuần: không hiển thị HTML; chỉ địa chỉ `http://` và `https://` được tự nhận thành liên kết (mở tab mới, `rel="noopener noreferrer nofollow"`).
- **Đã xem:** chỉ hiện dưới **tin cuối cùng của chính mình** trong phòng (không hiện trên mọi tin, không hiện cho tin đã xoá). Chat 1-1: "Đã xem" khi người kia đã đọc tới tin đó. Nhóm: "Đã xem bởi N người" (N chỉ tính người khác mình; rê chuột để thấy tên). Nhãn cập nhật tức thì khi người khác mở phòng, và được tải lại đúng sau khi mất kết nối rồi nối lại.
- **Đang soạn tin:** dòng "<Tên> đang soạn tin…" ngay trên ô soạn khi người khác trong phòng đang gõ (hai người: "A và B đang soạn tin…", nhiều hơn: "Nhiều người đang soạn tin…"). Dòng tự mất 5 giây sau tín hiệu cuối, hoặc ngay khi người đó gửi tin. Trình duyệt báo "đang soạn" tối đa 1 lần/3 giây mỗi phòng và không báo khi ô soạn trống; không bao giờ hiện chính mình.
- **Online:** chấm xanh ở ảnh đại diện của phòng 1-1 và dòng "Đang hoạt động" ở đầu hội thoại 1-1 khi người kia đang mở ứng dụng (ít nhất một tab). Đóng tab cuối cùng thì chấm mất ngay; tab/máy bị treo hoặc mất mạng thì chấm mất sau khoảng 45-60 giây (`PRESENCE_TTL_SECONDS` + một chu kỳ quét). **Quyền riêng tư:** chỉ thấy trạng thái online của người **chung ít nhất một phòng chưa lưu trữ** với mình; không có danh sách online toàn công ty, admin cũng không được thấy thêm. Không có "lần cuối online".

**Trả lời, @nhắc tên và thông báo.**
- **Trả lời:** rê chuột (hoặc Tab tới) một tin rồi bấm nút "Trả lời" (↩) cạnh bong bóng; ô soạn hiện "Đang trả lời <Tên>: <trích>" với nút ✕ (hoặc Esc) để huỷ. Tin gửi đi mang khối trích dẫn (tên người gửi gốc + tối đa 120 ký tự). Bấm khối trích dẫn thì cuộn tới tin gốc và nháy sáng nếu tin đó đang nằm trong phần đã tải (nhảy tới tin ở xa làm ở Plan 7). Chỉ trả lời được tin **cùng phòng**, chưa bị xoá. Tin gốc về sau bị sửa/xoá thì mọi trích dẫn cập nhật ngay; tin đã xoá hiện "Tin nhắn đã bị xoá" và không lộ nội dung cũ. Nếu tin gốc bị xoá đúng lúc đang gửi, tin trả lời báo lỗi với nút "Gửi không kèm trả lời".
- **@nhắc tên:** gõ `@` ở đầu một từ để mở gợi ý thành viên của phòng (không gồm chính mình); gõ tiếp để lọc, không cần dấu ("quoc" khớp "Quốc"). Mũi tên lên/xuống để chọn, Enter hoặc Tab chèn `@Họ Tên ` (Enter lúc gợi ý đang mở **không** gửi tin), Esc đóng gợi ý. Xoá chữ `@Họ Tên` khỏi ô soạn thì người đó không còn bị nhắc. Tên được nhắc hiện nổi bật trong tin; tin nhắc **mình** có viền màu. Thanh bên hiện nhãn "@" cạnh số chưa đọc khi có tin chưa đọc nhắc mình; mở phòng thì mất.
- **@all:** chỉ trong **nhóm** (không có trong chat 1-1), mục "@all — Nhắc tất cả mọi người" đứng đầu gợi ý; mọi thành viên khác được tính là bị nhắc (nhãn "@", viền, thông báo). Máy chủ chỉ chấp nhận khi nội dung có chữ `@all` đứng riêng (và `@Họ Tên` cũng chỉ tính khi đứng riêng: không dính chữ/số/`@`/`/` ngay trước, không dính chữ/số ngay sau, nên `email@An` hay URL `…/@Bob` không phải mention); mỗi người tối đa `MENTION_ALL_PER_WINDOW` tin `@all` trong `MENTION_ALL_WINDOW_SECONDS` giây (mặc định 10 tin/10 phút, mọi phòng cộng lại), vượt thì tin không được gửi (`rate_limited`, giao diện báo "đã dùng hết lượt @all" và có nút "Gửi không kèm @all"). Sửa tin không thêm được `@all` mới.
- **Thông báo trình duyệt** (nút "Thông báo" ở chân cột trái; mặc định **tắt** cho tới khi người dùng tự bật; trình duyệt chỉ hỏi quyền khi bấm "Bật thông báo trình duyệt"). Khi bật, có cửa sổ thông báo (tiêu đề là tên phòng/người, nội dung "<Người gửi>: <tin>") cho tin **của người khác** vừa đến trực tiếp qua WebSocket, khi cửa sổ đang ẩn/không có tiêu điểm hoặc đang mở phòng khác, và tin thuộc một trong: chat 1-1; nhắc tên mình hoặc `@all`; trả lời tin của mình; (tuỳ chọn "Mọi tin trong nhóm", mặc định tắt) mọi tin nhóm. Không bao giờ báo tin của chính mình, tin đã xoá, tin của phòng đang xem khi cửa sổ đang hiển thị và có tiêu điểm, hay tin cũ được tải bù sau khi mất kết nối (chỉ tin vừa đến trực tiếp qua WebSocket mới báo; tin tải bù/trùng bị loại từ cấu trúc, luật "cũ hơn 60 giây" chỉ là lưới an toàn). Cài đặt thông báo lưu theo từng người dùng trên trình duyệt (máy dùng chung không thừa hưởng cài đặt của người trước) và mọi thông báo đang mở được đóng khi đăng xuất. Âm báo và số chưa đọc trên tiêu đề vẫn hoạt động ngay cả khi chưa bật/không dùng được thông báo trình duyệt (ví dụ HTTP thuần). Mỗi phòng chỉ giữ một thông báo (thông báo mới thay cái cũ, tự đóng sau 8 giây); bấm vào thông báo thì mở đúng phòng.
- **Âm báo** (mặc định bật, tắt được) phát cùng các trường hợp trên, kể cả khi không có quyền thông báo; trình duyệt chỉ cho phát âm sau lần chạm/gõ phím đầu tiên trên trang. **Tiêu đề tab** luôn là `(N) Kết Nối` với N là tổng số chưa đọc (trên 99 hiện `99+`), về `Kết Nối` khi đọc hết; không phụ thuộc quyền thông báo.
- **HTTP và HTTPS:** trình duyệt chỉ cho Web Notification ở ngữ cảnh an toàn (HTTPS hoặc `localhost`). Truy cập bằng `http://<IP nội bộ>` thì hộp cài đặt hiện "Cần HTTPS để bật thông báo"; âm báo và số chưa đọc trên tiêu đề tab vẫn hoạt động. HTTPS nội bộ làm ở Plan 8.
- **Quyền riêng tư:** nội dung tin hiện trên màn hình khoá/khu vực thông báo của máy. Tắt "Hiện nội dung tin" thì thông báo chỉ ghi "Tin nhắn mới" (tên phòng/người gửi vẫn hiện). Cài đặt lưu trong trình duyệt (`localStorage`, theo từng máy), không gửi lên máy chủ.

**Nhóm do người dùng tạo.**
- **Tạo:** "+ Mới" → tab "Tạo nhóm": đặt tên (tối đa 100 ký tự), tìm và tích chọn thành viên từ danh bạ toàn công ty (khác chi nhánh cũng được; danh sách ghi chi nhánh của từng người), bấm "Tạo nhóm" thì vào thẳng phòng mới. Người tạo là **chủ nhóm**. Nhóm do người dùng tạo là nhóm "Liên chi nhánh" (`branch_id` rỗng). Người được mời thấy nhóm ngay, không cần tải lại trang.
- **Bảng "Thông tin nhóm":** nút ⓘ ở đầu cuộc trò chuyện nhóm mở bảng gồm danh sách thành viên ("· Bạn", "· Chủ nhóm") và nút "Rời nhóm". **Chỉ chủ nhóm** thấy thêm các điều khiển: đổi tên ("Lưu tên"), tìm và thêm thành viên, nút "Gỡ" cạnh từng người, và vùng "Giải tán nhóm". Thành viên khác chỉ chat và tự rời nhóm. Nhóm do admin tạo không có chủ: người dùng thường không quản lý được nhóm đó, nhưng vẫn rời được. Quyền thật do server quyết định: nếu bị từ chối (403/409), bảng hiện lỗi tiếng Việt, ví dụ "Bạn đang quản lý quá nhiều nhóm. Hãy giải tán bớt." khi vượt giới hạn.
- **Gỡ thành viên:** cần xác nhận. Người bị gỡ mất nhóm ngay: nhóm biến mất khỏi danh sách, trang đang mở nhóm báo "không còn trong đó", và họ không gửi hay nhận được gì nữa. Tin nhắn cũ vẫn ở lại cho những người còn trong nhóm. Nếu được thêm lại, họ thấy toàn bộ lịch sử, còn mốc đã đọc đặt ở tin mới nhất. Người mới được thêm cũng vậy: thấy lịch sử, không có số chưa đọc cho tin cũ.
- **Rời nhóm:** cần xác nhận, rời xong thì về danh sách. Khi **chủ nhóm rời**, quyền chủ chuyển cho thành viên vào nhóm sớm nhất còn lại (nếu bằng nhau thì người có id nhỏ nhất); người đó thấy điều khiển quản lý ngay. Người cuối cùng rời thì nhóm được lưu trữ.
- **Giải tán:** chủ nhóm gõ lại **đúng** tên nhóm (phân biệt hoa thường) thì nút "Giải tán nhóm" mới bật. Nhóm biến mất ngay với mọi thành viên và được **lưu trữ** như khi admin xoá: admin khôi phục được ở tab "Đã lưu trữ" trong thời gian giữ (mặc định 3 ngày), sau đó nhóm bị xoá vĩnh viễn cùng tin nhắn. Khôi phục thì thành viên và chủ nhóm giữ nguyên như trước.
- **Giới hạn:** mỗi người là chủ tối đa `MAX_OWNED_GROUPS` nhóm đang hoạt động (mặc định 20; nhóm đã giải tán/lưu trữ không tính). Mỗi nhóm có tối đa `MAX_GROUP_MEMBERS` thành viên, kể cả người tạo (mặc định 200, cũng áp dụng khi admin thêm thành viên). Giới hạn số nhóm làm chủ **chỉ kiểm tra lúc tạo nhóm**: nhận quyền chủ (chủ cũ rời hoặc bị admin gỡ) hay admin khôi phục nhóm có thể làm một người vượt `MAX_OWNED_GROUPS`.

**Trang admin "Phòng và nhóm"** (`/admin/rooms`): tìm và lọc nhóm theo chi nhánh; tạo nhóm (tên, chi nhánh hoặc liên chi nhánh, chọn thành viên); đổi tên; thêm, gỡ thành viên. Nhóm do người dùng tạo cũng hiện ở đây (là nhóm "Liên chi nhánh"); admin gỡ chủ nhóm thì quyền chủ chuyển như khi chủ tự rời. Admin không xem được nội dung tin nhắn. **"Xoá" nhóm là lưu trữ**: phải gõ lại đúng tên nhóm để xác nhận; nhóm biến mất ngay với mọi thành viên nhưng được giữ (mặc định 3 ngày) ở tab "Đã lưu trữ" (kèm thời điểm xoá) và có thể **"Khôi phục"** nguyên vẹn cùng tin nhắn trong thời gian đó; hết hạn thì tự động bị **xoá vĩnh viễn cùng toàn bộ tin nhắn**. Số ngày giữ đặt bằng `ROOM_ARCHIVE_RETENTION_DAYS` (mặc định 3), chu kỳ dọn bằng `ROOM_PURGE_INTERVAL_SECONDS` (xem `.env.example`).

### Kiểm tra trên trình duyệt thật: `scripts/e2e_chat_ui.mjs`

**Chỉ chạy trên stack thử nghiệm**: script tạo người dùng và nhóm, đổi mật khẩu admin, khoá một tài khoản. Nó điều khiển Chromium qua Playwright với hai người dùng song song và kiểm: gửi/nhận tức thì, chưa đọc, nhắn riêng mới, mất mạng rồi nối lại (bù tin, không trùng), gửi khi mất mạng, sửa/xoá, cuộn (đúng đáy khi mở, giữ vị trí khi tải tin cũ, "↓ N tin mới"), an toàn liên kết/HTML, token không nằm trong storage hay URL, giao diện điện thoại 390px, lưu trữ và khôi phục nhóm, online (đóng/mở trang, hai tab đóng một), "đang soạn tin" (hiện, tự hết hạn, mất khi gửi), "đã xem" (1-1 và "Đã xem bởi N người" trong nhóm), trạng thái đúng sau khi mất mạng rồi nối lại, quyền riêng tư của online (`GET /presence` không lộ người không chung phòng), trả lời (trích dẫn đúng, bấm thì cuộn tới và nháy, xoá tin gốc thì trích dẫn đổi ngay, `reply_to_id` của phòng khác/tin đã xoá bị từ chối `invalid_reply`), @nhắc tên (gợi ý, lọc không dấu, Enter chọn không gửi, nhãn "@" ở thanh bên, xoá chữ `@Tên` thì không gửi kèm mention, kiểm cả frame gửi lên lẫn REST), `@all` (đứng đầu gợi ý trong nhóm, không có trong 1-1, máy chủ bỏ cờ khi thiếu chữ `@all`, giới hạn tốc độ), thông báo trình duyệt (bật trong cài đặt; đúng một thông báo và một tiếng với tiêu đề/nội dung/tag đúng; không báo tin nhóm thường, tin đang xem hay tin bù sau khi mất kết nối; báo cho phòng 1-1 vừa được tạo; tắt xem trước thì "Tin nhắn mới"; tiêu đề tab `(N) Kết Nối`), nhóm do người dùng tạo (tạo nhóm liên chi nhánh qua "Tạo nhóm"; chủ nhóm đổi tên, thêm, gỡ thành viên bằng bàn phím với focus ở lại trong hộp thoại; người bị gỡ mất quyền ngay qua giao diện, REST và WebSocket; thành viên thường không có điều khiển quản lý và bị 403; chủ rời thì quyền chuyển ngay; giải tán phải gõ đúng tên, admin khôi phục; giới hạn số nhóm làm chủ), khoá tài khoản, không có lỗi JavaScript hay hộp thoại ngoài dự kiến.

Playwright được cài **ngoài repo** (một lần):

```bash
mkdir /tmp/kn-e2e && cd /tmp/kn-e2e && npm init -y && npm i playwright@1.49.1 && npx playwright install chromium
```

Chạy (từ thư mục gốc repo, Node 22+, stack đã `docker compose up -d --build` và có admin mới tạo bằng `create-admin`). Stack thử nghiệm phải đặt `MAX_OWNED_GROUPS=3` (bước kiểm giới hạn số nhóm làm chủ) và `MENTION_ALL_PER_WINDOW=3` (bước kiểm giới hạn `@all`) trong `.env`, và nên đặt `PRESENCE_OFFLINE_GRACE_SECONDS=0.5`:

```bash
PLAYWRIGHT_DIR=/tmp/kn-e2e BASE_URL=http://localhost ADMIN_USER=ui.admin ADMIN_TEMP_PASSWORD=<mật khẩu tạm> \
  node scripts/e2e_chat_ui.mjs
```

Mật khẩu mới của admin do script sinh ngẫu nhiên và in ra một lần ở đầu; chạy lại trên cùng stack **bắt buộc** đặt `E2E_ADMIN_NEW_PASSWORD=<mật khẩu đã in>` (hoặc tự đặt giá trị ngay từ lần đầu).

Ghi chú: script từ chối `BASE_URL` không phải localhost trừ khi đặt `E2E_ALLOW_REMOTE=1`. `context.setOffline` của Chromium không ngắt WebSocket, nên script đưa WebSocket qua proxy của Playwright (`routeWebSocket`) và tự cắt kết nối để mô phỏng mất mạng; proxy này cũng ghi lại các frame `send` mà trang gửi lên để kiểm `reply_to_id`/`mentions`/`mention_all`. Script chạy Chromium đầy đủ ở chế độ headless mới (`channel: 'chromium'`, có sẵn sau `npx playwright install chromium`) vì bản `chromium-headless-shell` mặc định luôn báo quyền thông báo là `denied`. Phần thông báo cấp quyền `notifications` cho trang của Bob, thay `Notification`/`AudioContext` bằng bản ghi lại lời gọi (`addInitScript`) và giả lập trạng thái tab ẩn (Chromium headless không đổi `document.visibilityState` khi chuyển tab). `localhost` là ngữ cảnh an toàn nên trường hợp HTTP thuần ("Cần HTTPS để bật thông báo") chỉ được kiểm bằng test đơn vị của frontend.

Script in `PASS`/`FAIL` cho từng bước, tổng kết `N/M đạt` và thoát mã 1 nếu có bước hỏng. Tuỳ chọn: `SHOT_DIR=<thư mục>` để lưu ảnh chụp các trang khi một bước hỏng, `HEADED=1` để xem trình duyệt chạy. Tên người dùng và nhóm có hậu tố ngẫu nhiên nên chạy lại được trên cùng stack (admin đã đổi mật khẩu ở lần chạy trước chỉ dùng lại được khi đặt `E2E_ADMIN_NEW_PASSWORD` đúng giá trị đã in).

## API chat (tóm tắt)

Tất cả dưới `/api`, cần `Authorization: Bearer <access token>` và đã đổi mật khẩu lần đầu.

| Việc | Endpoint |
|---|---|
| Tìm đồng nghiệp để nhắn riêng | `GET /users/directory?q=` |
| Danh sách phòng của tôi (kèm tin cuối, số chưa đọc) | `GET /rooms` → mỗi phòng có `my_role`: `"owner"` (tôi là chủ nhóm), `"member"`, hoặc `null` (phòng 1-1), và `unread_mentions`: số tin chưa đọc (sau mốc đã đọc, không tính tin của mình và tin đã xoá) nhắc tên tôi hoặc có `@all` |
| Mở chat 1-1 | `POST /rooms/direct` `{"user_id": 3}` |
| Tạo nhóm (người tạo là chủ) | `POST /rooms/group` `{"name": "...", "member_ids": [3, 7]}` → 201 phòng mới. Tên 1-100 ký tự (tự cắt khoảng trắng), `member_ids` bỏ trùng và bỏ chính mình. Người không tồn tại/bị khoá → `404 user_not_found` (không tạo gì); vượt `MAX_OWNED_GROUPS` → `409 too_many_groups`; vượt `MAX_GROUP_MEMBERS` → `409 group_full` |
| Đổi tên nhóm (chỉ chủ) | `PATCH /rooms/{id}` `{"name": "..."}` → phòng |
| Thêm thành viên (chỉ chủ) | `POST /rooms/{id}/members` `{"user_id": 9}` → danh sách thành viên mới. Đã là thành viên: 200, không đổi gì. Người mới thấy lịch sử, mốc đã đọc = tin mới nhất. Đầy → `409 group_full` |
| Gỡ thành viên (chỉ chủ) | `DELETE /rooms/{id}/members/{user_id}` → danh sách thành viên mới. Gỡ chính mình → `400 cannot_remove_self` (dùng rời nhóm); không phải thành viên → `404 member_not_found` |
| Rời nhóm (mọi thành viên, kể cả nhóm admin tạo) | `POST /rooms/{id}/leave` → 204. Chủ rời: quyền chủ chuyển cho người vào sớm nhất (bằng nhau thì `user_id` nhỏ nhất); người cuối cùng rời: nhóm được lưu trữ |
| Giải tán nhóm (chỉ chủ) | `DELETE /rooms/{id}` → 204, lưu trữ như admin xoá (xem dưới) |
| Lịch sử tin nhắn (con trỏ) | `GET /rooms/{id}/messages?before=&after=&around=&limit=` |
| Đánh dấu đã đọc (phát `read` cho cả phòng khi mốc tăng) | `POST /rooms/{id}/read` `{"message_id": 10}` |
| Thành viên và mốc đã đọc của từng người | `GET /rooms/{id}/members` → `[{"user_id", "full_name", "role" ("owner" hoặc "member"), "last_read_message_id" (hoặc null)}]`, sắp theo tên; không phải thành viên hoặc phòng đã lưu trữ → `404 room_not_found` |
| Ai đang online (chỉ người chung phòng với tôi, không gồm chính tôi) | `GET /presence` → `{"online_user_ids": [3, 7]}` |
| Sửa / xoá tin của mình | `PATCH /messages/{id}` `{"body": "...", "mentions": [3]}` (`mentions` tuỳ chọn; bỏ qua thì giữ các mention cũ mà chữ `@Tên` còn trong nội dung mới; `mention_all` chỉ được giữ khi `@all` còn trong nội dung, không thêm mới được; không đổi `reply_to`) / `DELETE /messages/{id}` |
| Admin quản lý nhóm | `/admin/rooms` (tạo, đổi tên, thêm/bớt thành viên, lưu trữ = xoá; `?archived=true` xem nhóm đã lưu trữ; `POST /admin/rooms/{id}/restore` khôi phục) |

**Dạng một tin nhắn** (trong `message`, `message_updated`, `GET /rooms/{id}/messages`, `PATCH /messages/{id}` và `last_message` của `GET /rooms`): `{"id", "room_id", "sender_id", "sender_name", "body", "kind", "client_id", "created_at", "edited_at", "deleted", "reply_to", "mentions", "mention_all"}`.
- `reply_to`: `{"id", "sender_id", "sender_name", "snippet", "deleted"}` hoặc `null`. `snippet` tối đa 120 ký tự (cắt theo ký tự Unicode, bỏ ký tự điều khiển, xuống dòng thành khoảng trắng), rỗng khi tin gốc đã bị xoá (`deleted: true`). Tin gốc không còn (phòng bị xoá vĩnh viễn) thì `null`.
- `mentions`: `[{"user_id", "full_name"}]` (rỗng nếu không nhắc ai); `mention_all`: `true` khi tin `@all` được chấp nhận. Tin đã xoá không mang `reply_to`/`mentions`.
- Một trang tin nhắn nạp trích dẫn và mention bằng truy vấn gộp (số truy vấn cố định, không N+1).

**Quyền với các endpoint nhóm của người dùng:** thành viên không phải chủ gọi đổi tên/thêm/gỡ/giải tán → `403 forbidden` (nhóm do admin tạo không có chủ nên luôn là 403); người ngoài nhóm, phòng 1-1 và nhóm đã lưu trữ → `404 room_not_found` (không lộ nhóm có tồn tại hay không). Mỗi thay đổi (tạo, đổi tên, thêm, gỡ, rời, giải tán) gửi `rooms_changed` cho mọi người bị ảnh hưởng, kể cả người vừa bị gỡ hoặc vừa rời, nên người đó không còn nhận `message`/`typing`/`read`/`presence` của nhóm.

### Phân trang tin nhắn

`GET /rooms/{id}/messages` nhận tối đa **một** trong `before`, `after`, `around` (nhiều hơn một: `400 invalid_cursor`), cùng `limit` từ 1 đến 100 (mặc định 50). Các tham số `before`/`after`/`around` phải ≥ 1; muốn "từ đầu" thì **bỏ tham số** thay vì gửi `0` (server trả 422). Mọi id phải là số nguyên dương trong khoảng cột DB (phòng/người dùng/chi nhánh tới 2^31-1, tin nhắn tới 2^63-1); ngoài khoảng là `422`.

- Không tham số: trang mới nhất. `before=<id>`: các tin cũ hơn id đó. `after=<id>`: các tin mới hơn id đó (cũ nhất trước). `around=<id>`: tin đó ở giữa cùng tin cũ và mới hơn (`404 message_not_found` nếu không thuộc phòng).
- `items` luôn sắp xếp **tăng dần** theo id.
- `has_more_before` có nghĩa với trang mặc định và `before`; `has_more_after` có nghĩa với `after`; với `around` cả hai đều có nghĩa. Trường còn lại luôn là `false`.

### WebSocket `/api/ws`

Mở kết nối rồi gửi ngay `{"type":"auth","token":"<access token>"}` (trong 5 giây). Sau khi nhận `{"type":"ready","user_id":1}`, gửi tin bằng `{"type":"send","room_id":1,"body":"...","client_id":"<uuid>"}` (`client_id` tối đa 64 ký tự, gửi lại cùng `client_id` là idempotent: bản đầu thắng, `reply_to_id`/`mentions` của lần sau bị bỏ qua). Trường tuỳ chọn của `send`:
- `reply_to_id` (số nguyên ≥ 1): trả lời tin đó. Tin không tồn tại, thuộc phòng khác hoặc đã xoá → `error` `invalid_reply`, tin **không** được tạo.
- `mentions` (mảng số nguyên ≥ 1, tối đa 200 phần tử thô): id người được nhắc. Máy chủ không phân tích văn bản để tìm người, chỉ giữ id là thành viên phòng **và** có chữ `@{full_name}` trong nội dung; bỏ trùng, tối đa 20 id; id không hợp lệ bị bỏ im lặng (không lỗi, không lộ người đó có tồn tại).
- `mention_all` (bool): chỉ được chấp nhận trong nhóm và khi nội dung có `@all` đứng riêng (không dính chữ/số trước hoặc sau); ngược lại tin vẫn được gửi với `mention_all: false`. Vượt giới hạn `@all` → `error` `rate_limited`, tin không được tạo.
- Sai kiểu/khoảng (`reply_to_id`, phần tử `mentions`, `mention_all` không phải bool) → `invalid_message`. Ping: `{"type":"ping"}` trả `{"type":"pong"}`. Server đẩy xuống: `message`, `message_updated`, `message_deleted`, `rooms_changed`, `resync`, `typing`, `read`, `presence`, `error` (`{"type":"error","code":"...","client_id":...}`).

**Đã xem, đang soạn tin, online**

| Hướng | Frame | Ghi chú |
|---|---|---|
| Client → server | `{"type":"typing","room_id":1}` | Báo đang gõ. Server giới hạn 1 frame/`WS_TYPING_INTERVAL_SECONDS` (mặc định 2 giây) mỗi phòng mỗi kết nối; vượt giới hạn hoặc phòng không phải của mình thì **bỏ qua im lặng** (không báo lỗi, tránh lộ phòng nào tồn tại); `room_id` sai kiểu/khoảng → `invalid_message`. Không tính vào giới hạn 20 tin/10 giây. |
| Server → client | `{"type":"typing","room_id":1,"user_id":3,"user_name":"Trần Quốc Huy"}` | Phát cho mọi kết nối trong phòng (kể cả các tab của chính người gõ: client tự bỏ qua `user_id` của mình). `user_id`/`user_name` lấy từ kết nối đã xác thực, không tin dữ liệu client gửi. Không lưu ở server: client tự cho hết hạn sau 5 giây và xoá ngay khi nhận `message` của người đó. |
| Server → client | `{"type":"read","room_id":1,"user_id":3,"message_id":42}` | Sau `POST /rooms/{id}/read`, **chỉ khi mốc đã đọc thực sự tăng**. Tới cả các tab khác của chính người đọc (đồng bộ số chưa đọc giữa các tab). |
| Server → client | `{"type":"presence","user_id":3,"online":true}` | Khi một người chuyển online/offline; chỉ tới những người chung phòng với họ. Online = còn ít nhất một kết nối WebSocket chưa hết hạn. |

`typing`/`read` không bao giờ được gửi cho người không thuộc phòng (kể cả người vừa bị gỡ hoặc phòng đã lưu trữ). Redis lỗi không làm hỏng gửi/nhận tin: các tín hiệu này chỉ bị bỏ và ghi log.

**Mã đóng kết nối và cách client phản ứng**

| Mã | Ý nghĩa | Client làm gì |
|---|---|---|
| 4401 | Chưa xác thực, token sai/hết hạn, hoặc thông tin đăng nhập vừa đổi (đổi mật khẩu, admin đặt lại mật khẩu) | Làm mới token (`POST /auth/refresh`) rồi kết nối lại; nếu refresh thất bại thì về trang đăng nhập |
| 4403 | Tài khoản bị khoá (đối soát định kỳ chỉ dùng 4403 cho tài khoản bị khoá; tài khoản phải đổi mật khẩu bị đóng 4401) | **Không** kết nối lại, về trang đăng nhập |
| 4408 | Client quá chậm (hàng đợi gửi đầy) | Kết nối lại và tải phần còn thiếu (xem quy tắc catch-up bên dưới) |
| 4413 | Frame quá lớn | Không gửi lại đúng frame đó (kết nối lại được, nhưng đừng retry cùng nội dung) |

**Không mở WebSocket khi người dùng chưa đổi mật khẩu lần đầu** (`must_change_password`): server đóng 4401, mà làm mới token vẫn thành công, nên client sẽ lặp vô hạn nếu không kiểm tra cờ này trước.

Giới hạn frame là **16 KiB tính theo byte UTF-8** (không phải số ký tự; tiếng Việt có dấu tốn nhiều byte hơn), áp dụng cả cho frame `auth`. Trần cứng của tầng transport là 64 KiB (vượt thì đóng với mã 1009).

**Giới hạn tốc độ**: mặc định 20 tin `send` mỗi 10 giây trên mỗi kết nối (`WS_RATE_LIMIT_MESSAGES`, `WS_RATE_LIMIT_SECONDS`). Vượt thì server trả `{"type":"error","code":"rate_limited","client_id":...}` và bỏ tin đó, kết nối vẫn mở.

**Các giá trị `code` lỗi**

| `code` | Nơi gặp | Ghi chú |
|---|---|---|
| `empty_message` | WS, REST | Nội dung rỗng sau khi cắt khoảng trắng |
| `message_too_long` | WS, REST | Vượt 4000 ký tự (`MAX_MESSAGE_LENGTH`) khi gửi; khi sửa tin chỉ trong khoảng 4001-10000 ký tự, trên 10000 ký tự REST trả 422 `validation_error` |
| `invalid_client_id` | WS (không có REST gửi tin) | `client_id` rỗng hoặc dài quá 64 ký tự (echo lại `client_id: null`) |
| `invalid_message` | WS, REST | Sai kiểu/khoảng giá trị (`room_id`, `body`, `client_id`...) hoặc chứa ký tự NUL |
| `invalid_reply` | WS (400) | `reply_to_id` không tồn tại, thuộc phòng khác hoặc là tin đã xoá ("Không trả lời được tin này."); tin không được tạo |
| `invalid_json` | WS | Frame không phải JSON |
| `unknown_type` | WS | `type` không hỗ trợ |
| `unsupported_frame` | WS | Frame nhị phân |
| `rate_limited` | WS | Quá 20 tin/10 giây mỗi kết nối (xem trên), hoặc quá giới hạn tin `@all` (`MENTION_ALL_PER_WINDOW`) |
| `internal_error` | WS | Lỗi phía server khi gửi tin; thử lại được |
| `room_not_found` | WS, REST | Không phải thành viên hoặc phòng không tồn tại (admin cũng không đọc/gửi được nếu không là thành viên) |
| `message_not_found` | REST | Tin không tồn tại hoặc không thuộc phòng |
| `user_not_found` | REST | Người dùng không tồn tại hoặc đã bị khoá |
| `cannot_chat_with_self` | REST | Mở chat 1-1 với chính mình |
| `invalid_cursor` | REST | Truyền nhiều hơn một trong `before`/`after`/`around` |
| `forbidden` | REST | Sửa/xoá tin của người khác, không phải admin, hoặc quản lý nhóm khi không phải chủ nhóm |
| `conflict` | REST (409) | Hai thao tác quản lý nhóm đụng nhau và vẫn deadlock sau một lần thử lại; thử lại được |
| `group_empty` | REST (409) | Admin khôi phục nhóm đã lưu trữ khi không còn thành viên nào (ví dụ người cuối đã rời) |
| `rate_limited` | REST (429) | Quá giới hạn thao tác nhóm theo người dùng: `GROUP_CREATE_PER_MINUTE`, `GROUP_WRITE_PER_MINUTE` hoặc trần `GROUP_CREATE_PER_DAY` (xem "Giới hạn nhóm") |
| `too_many_groups` | REST (409) | Tạo nhóm khi đã là chủ `MAX_OWNED_GROUPS` nhóm đang hoạt động |
| `group_full` | REST (409) | Nhóm sẽ vượt `MAX_GROUP_MEMBERS` thành viên (tạo nhóm hoặc thêm thành viên) |
| `cannot_remove_self` | REST (400) | Chủ nhóm tự gỡ mình bằng `DELETE /rooms/{id}/members/{user_id}`; dùng `POST /rooms/{id}/leave` |
| `member_not_found` | REST | Gỡ người không phải thành viên nhóm (cả trang admin) |
| `not_authenticated` | REST | Thiếu/sai access token (WS: đóng 4401) |
| `password_change_required` | REST | Phải đổi mật khẩu trước |
| `service_unavailable` | REST (503) | Redis lỗi |
| `branch_not_found`, `branch_exists`, `branch_has_users`, `username_taken`, `cannot_modify_self` | REST (admin) | Quản trị người dùng/chi nhánh/nhóm |
| `invalid_credentials`, `too_many_attempts`, `invalid_refresh`, `wrong_current_password`, `password_unchanged` | REST (auth) | Đăng nhập và đổi mật khẩu |

Lỗi REST có dạng `{"detail":"<code>"}`; sai kiểu/khoảng giá trị đầu vào là `422` với `detail` là danh sách lỗi của FastAPI.

**Quy tắc đồng bộ cho client**

- Sau **mỗi** `ready` (không chỉ khi kết nối lại) và khi nhận `resync`: với từng phòng đang mở/đã tải, gọi `GET /rooms/{id}/messages?after=<id tin cuối đã có>` (lặp tới khi `has_more_after` là `false`) và tải lại `GET /rooms`. Tin có thể đã đến giữa lúc tải lịch sử và lúc kết nối xong.
- Cũng sau mỗi `ready`/`resync`: tải lại `GET /presence` và `GET /rooms/{id}/members` của phòng đang mở, vì các sự kiện `presence`/`read` trong lúc mất kết nối đã bị lỡ. `typing` không cần bù (tự hết hạn).
- Nhận `rooms_changed` (được thêm/gỡ khỏi phòng, đổi tên nhóm, đổi chủ nhóm, rời nhóm, phòng bị xoá/giải tán/khôi phục): tải lại `GET /rooms` (và `GET /presence`, vì phòng chung mới có thể thêm người được thấy online).
- Server cũng tự đối soát định kỳ (`WS_RECONCILE_SECONDS`, mặc định 30 giây) và đóng kết nối của tài khoản đã khoá hoặc phải đổi mật khẩu, nên client phải xử lý 4401/4403 bất cứ lúc nào.

**Xoá nhóm = lưu trữ (mặc định 3 ngày) rồi xoá vĩnh viễn**: `DELETE /admin/rooms/{id}` (204) không xoá dữ liệu mà đặt `archived_at`. Nhóm đã lưu trữ biến mất với mọi người dùng thường (danh sách phòng, tin nhắn, gửi/sửa/xoá/đánh dấu đã đọc đều trả `404 room_not_found`, WebSocket không còn nhận tin của nhóm) và các thành viên nhận `rooms_changed`. Admin xem được bằng `GET /admin/rooms?archived=true` (mỗi nhóm có `archived_at` và `purge_at`), xem chi tiết bằng `GET /admin/rooms/{id}`, khôi phục bằng `POST /admin/rooms/{id}/restore` (thành viên thấy lại đủ tin nhắn và số chưa đọc cũ); đổi tên, thêm/gỡ thành viên trên nhóm đã lưu trữ trả `404 room_not_found`. Tiến trình nền (chạy lúc khởi động rồi mỗi `ROOM_PURGE_INTERVAL_SECONDS` giây, mặc định 3600) xoá vĩnh viễn nhóm đã lưu trữ quá `ROOM_ARCHIVE_RETENTION_DAYS` ngày (mặc định 3) cùng toàn bộ tin nhắn. Chủ nhóm giải tán nhóm do mình tạo (`DELETE /rooms/{id}`) dùng đúng cơ chế này. Phòng chat 1-1 không bị ảnh hưởng. Lưu ý: bản sao lưu DB vẫn chứa dữ liệu đã xoá vĩnh viễn cho tới khi hết hạn theo chính sách sao lưu (Plan 7). Giao diện admin vẫn phải xác nhận trước khi lưu trữ.

### Kiểm tra đầu-cuối: `scripts/e2e_chat_smoke.py`

> **CẢNH BÁO: chỉ chạy trên stack dùng một lần (throwaway). Không bao giờ chạy trên production.** Script tạo người dùng `e2e.alice`, `e2e.bob` và một nhóm, đặt mật khẩu quản trị đã biết trước (`E2eAdminPassw0rd!`) cho tài khoản admin được chỉ định, và **không chạy lại được** (lần hai sẽ lỗi vì người dùng đã tồn tại). Xong hãy huỷ cả stack và dữ liệu: `docker compose down -v`.

```bash
docker compose up -d --build
docker compose exec api python -m app.cli create-admin --username e2e.root --full-name "E2E Root" --branch-name "E2E" --branch-code E2E
# lấy mật khẩu tạm mà lệnh trên in ra, rồi:
docker compose exec -T api python /dev/stdin --base http://caddy --admin-user e2e.root --admin-temp-password '<mật khẩu tạm>' < scripts/e2e_chat_smoke.py
docker compose down -v
```

In `OK` nếu thành công; nếu không in một dòng `FAIL: ...` và thoát với mã 1.

## Tạo tài khoản quản trị đầu tiên

```bash
docker compose exec api python -m app.cli create-admin \
  --username long.pham --full-name "Phạm Đức Long" \
  --branch-name "Hà Nội" --branch-code HN
```

Lệnh in mật khẩu tạm một lần duy nhất và không thể xem lại sau đó, hãy sao chép ngay. Người dùng phải đổi mật khẩu khi đăng nhập lần đầu.

## Chạy test backend

```bash
bash scripts/test.sh -v
```

Lệnh này chỉ dành cho máy phát triển: nó khởi động db/redis cùng `docker-compose.override.yml` (mở cổng ở localhost), chạy pytest trong container python:3.12 nối vào mạng compose, không cần cài Python trên máy. Script đọc `POSTGRES_USER`/`POSTGRES_PASSWORD` từ `.env` và tự tạo database `messaging_test` nếu chưa có. Nên đặt `POSTGRES_PASSWORD` bằng `openssl rand -hex 32` (chuỗi hex an toàn trong `DATABASE_URL`; mật khẩu base64 có thể làm hỏng URL).

Nếu máy đã có Python 3.12 (cần Python 3.12), có thể chạy trực tiếp:

```bash
docker compose up -d db redis
docker compose exec db createdb -U messaging messaging_test   # chỉ lần đầu
cd backend
python -m venv .venv && source .venv/bin/activate              # Git Bash: source .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest -v
```

## Cấu hình thời gian thực (tuỳ chọn, xem `.env.example`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PRESENCE_TTL_SECONDS` | 45 | Một kết nối được coi là còn online bấy nhiêu giây sau lần gia hạn cuối (kết nối/worker chết mà không kịp gỡ sẽ tự hết hạn). Phải ít nhất gấp đôi `PRESENCE_SWEEP_SECONDS`. |
| `PRESENCE_SWEEP_SECONDS` | 15 | Chu kỳ mỗi worker gia hạn các kết nối đang mở của mình và đối soát người vừa online/offline. Ngắt kết nối bình thường được gỡ ngay, không chờ chu kỳ này. |
| `PRESENCE_ANNOUNCE_TIMEOUT_SECONDS` | 10 | Thời gian tối đa cho một lượt phát thông báo `presence` của một người. |
| `PRESENCE_OFFLINE_GRACE_SECONDS` | 5 | Thông báo **offline** bị hoãn bấy nhiêu giây rồi kiểm tra lại: người dùng tải lại trang hoặc mạng chập chờn nối lại kịp thì không có sự kiện nào. Online vẫn báo ngay. `0` = tắt. Khi chạy e2e (`scripts/e2e_chat_ui.mjs`) nên đặt giá trị nhỏ (ví dụ `0.5`), hoặc các bước chờ "mất chấm online" phải chờ lâu hơn khoảng ân hạn. |
| `WS_TYPING_INTERVAL_SECONDS` | 2 | Khoảng tối thiểu giữa hai sự kiện `typing` của một kết nối trong cùng một phòng. |

**Nhiều worker:** trạng thái online lưu chung trong Redis nhưng mỗi worker chỉ phát `presence` cho kết nối của mình và đối soát mỗi `PRESENCE_SWEEP_SECONDS`, nên khi chạy nhiều worker có thể có thông báo trùng hoặc trạng thái cũ tối đa khoảng một chu kỳ quét (client luôn tải lại `GET /presence` khi nối lại). Sự kiện tạm thời (`typing`, `read`, `presence`) bị bỏ khi hàng đợi của một kết nối chậm gần đầy, thay vì đóng kết nối.

## Giới hạn nhóm (tuỳ chọn, xem `.env.example`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MAX_OWNED_GROUPS` | 20 | Số nhóm **đang hoạt động** tối đa một người được làm chủ khi tạo nhóm mới (nhóm đã giải tán/lưu trữ không tính). Vượt: `409 too_many_groups`. Chỉ kiểm tra lúc tạo nhóm: nhận quyền chủ (chủ cũ rời hoặc bị admin gỡ) và admin khôi phục nhóm có thể làm một người vượt giới hạn này. |
| `MAX_GROUP_MEMBERS` | 200 | Số thành viên tối đa của một nhóm, kể cả người tạo; áp dụng khi tạo nhóm, khi chủ nhóm thêm và khi admin thêm thành viên. Vượt: `409 group_full`. |
| `GROUP_CREATE_PER_MINUTE` | 10 | Số lần `POST /rooms/group` tối đa mỗi người trong 60 giây (đếm cả lần bị từ chối). Vượt: `429 rate_limited`. |
| `GROUP_WRITE_PER_MINUTE` | 30 | Số thao tác nhóm khác (đổi tên, thêm/gỡ thành viên, rời, giải tán) tối đa mỗi người trong 60 giây. Vượt: `429 rate_limited`. |
| `GROUP_CREATE_PER_DAY` | 50 | Số nhóm một người tạo trong 24 giờ gần nhất, **tính cả nhóm đã giải tán/lưu trữ**, để tạo-giải tán liên tục không né được giới hạn. Vượt: `429 rate_limited`. |

Bộ đếm theo phút nằm trong Redis (khoá có tiền tố `BUS_CHANNEL_PREFIX`); Redis lỗi thì **cho qua** (ghi log cảnh báo) để thao tác nhóm không hỏng theo. Trần theo ngày đếm từ PostgreSQL nên không phụ thuộc Redis.

**Thời điểm mất quyền:** người bị gỡ/rời nhóm không thể gửi thêm tin vào nhóm đó ngay khi lệnh gỡ hoàn tất (việc gửi tin khoá dòng thành viên nên được tuần tự hoá với việc gỡ). Về phía nhận, kết nối WebSocket đang mở của họ ngừng nhận sự kiện của phòng sau khi hub xử lý `rooms_changed`; có thể còn một cửa sổ cỡ mili-giây giữa lúc gỡ xong và lúc hub cập nhật, trong đó họ vẫn nhận được vài sự kiện đã phát đi.

## Giới hạn `@all` (tuỳ chọn, xem `.env.example`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MENTION_ALL_PER_WINDOW` | 10 | Số tin `@all` tối đa của một người trong mỗi cửa sổ (mọi phòng cộng lại). Vượt: tin không được tạo, WS trả `rate_limited`. Stack chạy `scripts/e2e_chat_ui.mjs` phải đặt `3`. |
| `MENTION_ALL_WINDOW_SECONDS` | 600 | Độ dài cửa sổ (giây). |

Bộ đếm nằm trong Redis; Redis lỗi thì **cho qua** (ghi log cảnh báo) để việc gửi tin không hỏng theo.

## Cấu hình môi trường: `APP_ENV` và `COOKIE_SECURE`

Hai biến này độc lập với nhau.

- `APP_ENV` (`dev` | `test` | `prod`, mặc định trong `.env.example` là `prod`). Ở `prod`, api từ chối khởi động nếu `JWT_SECRET` là giá trị mẫu hoặc ngắn hơn 32 ký tự (xem `docker compose logs api`), và `/api/docs` bị tắt. Đặt `dev` khi phát triển cục bộ. Giá trị khác ba giá trị trên bị từ chối.
- Phải đặt `JWT_SECRET` thật (`openssl rand -hex 32`) trước lần khởi động đầu tiên. Giá trị mẫu trong `.env.example` cố ý bị từ chối ở `prod` để quên đổi thì lỗi ngay.
- `COOKIE_SECURE` điều khiển cờ `Secure` của cookie đăng nhập, không phụ thuộc `APP_ENV`. Khi chưa có HTTPS, Caddy chỉ nghe cổng 80 (HTTP), nên giữ `COOKIE_SECURE=false`, nếu không trình duyệt sẽ không lưu cookie. Khi bật HTTPS, đổi thành `COOKIE_SECURE=true`.
