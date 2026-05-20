# change-entry.html 4버튼 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `change-entry.html`의 단일 버튼 UI를 4개 버튼(쿠폰+변경 / 변경만 / 쿠폰만 / 정산 직전 변경)으로 확장하여 사용자가 입차시간 변경과 2시간 무료 쿠폰 적용을 개별/동시 수행할 수 있도록 한다.

**Architecture:** 단일 HTML 파일(`change-entry.html`)의 인라인 `<script>` 내부를 모듈화한다 — 공통 API 헬퍼(loadToken/getVehicleByStatus/patchEntryTime) + 쿠폰 헬퍼(hasFreeCoupon/getNextCoupon/applyCoupon) + 4개 버튼 핸들러(onBoth/onChangeOnly/onCouponOnly/onPostPaidChange) 구조. `apply-coupon.js`의 로직을 브라우저로 포팅한다.

**Tech Stack:** Vanilla HTML/CSS/JS (단일 파일), Fetch API. 자동화 테스트 인프라 없음 → 각 Task 후 수동 검증.

**Spec:** `docs/superpowers/specs/2026-05-20-change-entry-multi-button-design.md`

---

## File Structure

| 파일 | 변경 |
|---|---|
| `change-entry.html` | UI 마크업 + CSS + 인라인 스크립트 모두 수정 (단일 파일) |
| 기타 | 변경 없음 |

단일 파일이라 파일 분리 결정은 없다. 다만 인라인 스크립트 내부는 **공통 헬퍼 → 쿠폰 헬퍼 → 핸들러 → 부트스트랩** 순서로 섹션 주석을 두어 가독성을 확보한다.

---

## Task 1: 스크립트 리팩토링 — 공통 헬퍼 분리 (기존 동작 보존)

기존 `executeChange()` 함수에 직접 들어있는 로직(token 발급, vehicle 조회, entry PATCH)을 재사용 가능한 헬퍼로 분리한다. **이 Task의 핵심은 기존 UI/동작은 그대로 유지하면서 내부 구조만 정리하는 것** — regression 없는지가 검증 포인트.

**Files:**
- Modify: `change-entry.html` (script 블록 line 35~122)

- [ ] **Step 1: 현재 코드 백업 확인**

작업 전 git diff 깨끗한 상태 확인 — 만약 미커밋 변경이 있다면 먼저 stash/commit.

```bash
cd C:/Workspace/parking-coupon
git status
```

기대: `working tree clean` 또는 의도된 변경만 표시. (현재 로컬에 `retry-scheduled.yml`, `today-cleanup.yml` 미커밋 변경 존재 — 이 파일들은 건드리지 않으니 무시 가능, 단 의도치 않게 함께 커밋되지 않도록 주의)

- [ ] **Step 2: 스크립트 상단에 헬퍼 함수 추가**

`change-entry.html` 의 `<script>` 블록 안, 기존 `apiRequest` 함수 바로 뒤에 다음을 삽입한다.

```javascript
// ========================================
// 공통 API 헬퍼
// ========================================
const OWNER_ID = "66a9c4f0c920064e4a47abc9";
const COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713";

let _cachedToken = null;
async function loadToken() {
  if (_cachedToken) return _cachedToken;
  const data = await apiRequest("POST", "/auth/token", null, { id: LOGIN_ID, password: LOGIN_PW });
  _cachedToken = data.access_token;
  return _cachedToken;
}

async function getVehicleByStatus(token, status) {
  const data = await apiRequest("GET",
    `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&status=${status}`, token);
  const items = data.vehicleAccesses || [];
  return items.length ? items[0] : null;
}

async function patchEntryTime(token, va, nowIso) {
  const facility = va.entry.facility._id;
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    entry: { accessedAt: nowIso, facility }
  });
}
```

- [ ] **Step 3: `executeChange()` 함수를 헬퍼 사용으로 리팩토링**

기존 `executeChange()` 본문을 다음으로 교체한다.

```javascript
async function executeChange() {
  const btn = document.getElementById("btnChange");
  const resultBox = document.getElementById("resultBox");
  btn.disabled = true;
  btn.textContent = "변경 중...";
  resultBox.style.display = "none";

  try {
    const now = new Date();
    const newEntryIso = toIso(now);
    const token = await loadToken();
    const va = await getVehicleByStatus(token, "inParking");

    if (!va) {
      resultBox.className = "result nodata";
      resultBox.textContent = `${vehicle}: 현재 입차 기록이 없습니다 (미입차)`;
      resultBox.style.display = "block";
      btn.textContent = "현재 시간으로 변경";
      btn.disabled = false;
      return;
    }

    const oldEntry = new Date(va.entry.accessedAt);
    await patchEntryTime(token, va, newEntryIso);

    resultBox.className = "result success";
    resultBox.innerHTML = `변경 완료<br>${kstStr(oldEntry)} → ${kstStr(now)}`;
    resultBox.style.display = "block";
    btn.textContent = "변경 완료";
  } catch (e) {
    resultBox.className = "result error";
    resultBox.textContent = `오류: ${e.message}`;
    resultBox.style.display = "block";
    btn.textContent = "현재 시간으로 변경";
    btn.disabled = false;
  }
}
```

- [ ] **Step 4: 수동 회귀 검증**

브라우저에서 페이지 열고 기존 동작 확인:

```
file:///C:/Workspace/parking-coupon/change-entry.html?vehicle=16마1011
```

확인 항목:
- 페이지 로드 시 차량번호, 시간 표시 정상
- "현재 시간으로 변경" 버튼 클릭 시 기존과 동일하게 동작 (성공/미입차/에러 모두)
- 브라우저 콘솔에 에러 없음

수동 검증이라 자동화는 안 됨. 사용자가 실제 차량 상태로 확인 필요.

- [ ] **Step 5: 커밋**

```bash
cd C:/Workspace/parking-coupon
git add change-entry.html
git commit -m "feat: change-entry 스크립트 헬퍼 함수 분리 (기존 동작 유지)"
```

미커밋 상태인 `retry-scheduled.yml`, `today-cleanup.yml`은 stage하지 말 것.

---

## Task 2: 쿠폰 헬퍼 추가

`apply-coupon.js` 의 쿠폰 적용 로직을 브라우저로 포팅한다. 이 Task는 헬퍼만 추가하고 UI에서 호출은 아직 안 한다.

**Files:**
- Modify: `change-entry.html` (script 블록)

- [ ] **Step 1: 쿠폰 헬퍼 함수 3개 추가**

Task 1에서 추가한 공통 헬퍼 섹션 바로 아래에 다음을 삽입.

```javascript
// ========================================
// 쿠폰 헬퍼
// ========================================
function hasFreeCoupon(va) {
  const coupons = (va.payment || {}).discountCouponList || [];
  return coupons.some(cp => {
    const key = cp.discountCouponKey || {};
    return typeof key === "object" && (key.name || "").includes("방문자확인");
  });
}

async function getNextCoupon(token) {
  const data = await apiRequest("GET",
    `/discount-coupon-keys/coupon?owner=${OWNER_ID}&ownerModel=Admin`, token);
  for (const key of (data.discountCouponKeys || [])) {
    if (key._id === COUPON_KEY_2H) return { nextCoupon: key.nextCoupon, count: key.count || 0 };
  }
  return { nextCoupon: null, count: 0 };
}

async function applyCoupon(token, va, couponId) {
  let detail = await apiRequest("GET", `/vehicle-accesses/${va._id}`, token);
  if (detail.vehicleAccess) detail = detail.vehicleAccess;
  const existing = ((detail.payment || {}).discountCouponList || []).map(cp => cp._id);
  existing.push(couponId);
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    payment: { discountCouponList: existing }
  });
}
```

- [ ] **Step 2: 콘솔에서 헬퍼 동작 수동 검증**

브라우저 콘솔에서 직접 호출해서 검증.

```javascript
// 콘솔에서 실행
const t = await loadToken();
const va = await getVehicleByStatus(t, "inParking");
console.log(va);
console.log("쿠폰 보유:", hasFreeCoupon(va));
const c = await getNextCoupon(t);
console.log("다음 쿠폰:", c);
```

기대:
- `va` 객체에 `_id`, `entry.accessedAt`, `payment.discountCouponList` 표시
- `hasFreeCoupon` 은 boolean
- `getNextCoupon` 은 `{ nextCoupon: "...", count: N }` 또는 `{ nextCoupon: null, count: 0 }`

`applyCoupon` 은 실제 호출하면 영향이 있으므로 이 Step에서는 실행하지 않음.

- [ ] **Step 3: 커밋**

```bash
git add change-entry.html
git commit -m "feat: change-entry 쿠폰 헬퍼 함수 추가"
```

---

## Task 3: 4버튼 UI — CSS + HTML 마크업

UI를 4버튼 세로 스택 + 구분선으로 변경. 이 Task에서는 마크업만 잡고, 새 버튼들의 클릭 핸들러는 다음 Task에서 채움(임시로 빈 함수 호출).

**Files:**
- Modify: `change-entry.html` (style 블록 + body 마크업)

- [ ] **Step 1: CSS 추가 (outline / warning 버튼 + divider)**

`<style>` 블록의 기존 `.btn-primary` 정의 바로 아래에 다음을 삽입.

```css
.btn-outline { background: transparent; color: #00d2ff; border: 2px solid #00d2ff; }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-warning { background: #ffa726; color: #1a1a2e; }
.btn-warning:disabled { opacity: 0.5; cursor: not-allowed; }
.divider { border: 0; border-top: 1px solid #2a3a5a; margin: 16px 0 8px 0; }
```

- [ ] **Step 2: 버튼 마크업을 4개로 교체**

기존 `<button class="btn btn-primary" id="btnChange" ...>` 한 줄을 다음으로 교체.

```html
<button class="btn btn-primary" id="btnBoth" onclick="onBoth()">쿠폰 + 입차시간 변경</button>
<button class="btn btn-outline" id="btnChange" onclick="onChangeOnly()">현재 시간으로 변경</button>
<button class="btn btn-outline" id="btnCoupon" onclick="onCouponOnly()">2시간 무료 쿠폰 적용</button>
<hr class="divider">
<button class="btn btn-warning" id="btnPostPaid" onclick="onPostPaidChange()">정산 직전 입차시간 변경</button>
```

- [ ] **Step 3: 기존 `executeChange()` 함수명을 `onChangeOnly()` 로 변경**

`change-entry.html` 의 스크립트 블록에서 `executeChange` → `onChangeOnly` 로 함수명 변경 (1군데). `btnChange` 참조도 그대로 (id 변경 없음).

기존:
```javascript
async function executeChange() {
```

변경:
```javascript
async function onChangeOnly() {
```

- [ ] **Step 4: 나머지 3개 핸들러 자리만 잡기 (스텁)**

스크립트 블록 하단(`onChangeOnly` 함수 끝나는 `}` 바로 뒤)에 다음 스텁을 추가.

```javascript
async function onBoth() {
  alert("미구현 — Task 4에서 채워짐");
}
async function onCouponOnly() {
  alert("미구현 — Task 4에서 채워짐");
}
async function onPostPaidChange() {
  alert("미구현 — Task 4에서 채워짐");
}
```

- [ ] **Step 5: 수동 검증**

브라우저로 페이지 열고 시각 확인.

```
file:///C:/Workspace/parking-coupon/change-entry.html?vehicle=16마1011
```

확인 항목:
- 4개 버튼이 세로로 표시됨
- 첫 버튼만 청록 채움(primary), 2/3번은 청록 테두리(outline), 4번은 주황 채움(warning)
- 2/3번 버튼 사이는 일반 간격, 3/4번 사이에 구분선 있음
- "현재 시간으로 변경"(2번) 클릭 시 기존과 동일하게 동작 (Task 1과 동일)
- 나머지 3개 버튼 클릭 시 "미구현" alert
- 모바일 폭(375px, 브라우저 개발자도구 device 모드)에서 4개 버튼 + 결과박스 1탭 안에 보임

- [ ] **Step 6: 커밋**

```bash
git add change-entry.html
git commit -m "feat: change-entry 4버튼 UI 마크업 + CSS 추가"
```

---

## Task 4: 핸들러 구현 — onBoth / onCouponOnly / onPostPaidChange

3개 핸들러 본문을 채운다. UX 정책(success는 disabled 유지, error/nodata는 재활성화)을 통일된 패턴으로 적용.

**Files:**
- Modify: `change-entry.html` (script 블록 — Task 3에서 추가한 스텁 부분)

- [ ] **Step 1: UX 헬퍼 함수 추가**

스크립트 블록의 핸들러 섹션 위에 공통 disable/enable 헬퍼를 추가.

```javascript
// ========================================
// UX 헬퍼
// ========================================
const ALL_BTNS = ["btnBoth", "btnChange", "btnCoupon", "btnPostPaid"];
const BTN_LABELS = {
  btnBoth: "쿠폰 + 입차시간 변경",
  btnChange: "현재 시간으로 변경",
  btnCoupon: "2시간 무료 쿠폰 적용",
  btnPostPaid: "정산 직전 입차시간 변경"
};

function disableAllButtons(activeId, busyText) {
  for (const id of ALL_BTNS) {
    const el = document.getElementById(id);
    el.disabled = true;
    if (id === activeId) el.textContent = busyText;
  }
}

function reEnableAllButtons() {
  for (const id of ALL_BTNS) {
    const el = document.getElementById(id);
    el.disabled = false;
    el.textContent = BTN_LABELS[id];
  }
}

function showResult(cls, html) {
  const box = document.getElementById("resultBox");
  box.className = `result ${cls}`;
  box.innerHTML = html;
  box.style.display = "block";
}
```

- [ ] **Step 2: `onChangeOnly` 를 공통 헬퍼 사용으로 정리**

Task 1/3에서 만든 `onChangeOnly` 를 다음으로 교체. (기능은 동일하지만 UX 헬퍼 사용)

```javascript
async function onChangeOnly() {
  document.getElementById("resultBox").style.display = "none";
  disableAllButtons("btnChange", "변경 중...");
  try {
    const token = await loadToken();
    const va = await getVehicleByStatus(token, "inParking");
    if (!va) {
      showResult("nodata", `${vehicle}: 현재 입차 기록이 없습니다 (미입차)`);
      reEnableAllButtons();
      return;
    }
    const now = new Date();
    const oldEntry = new Date(va.entry.accessedAt);
    await patchEntryTime(token, va, toIso(now));
    showResult("success", `변경 완료<br>${kstStr(oldEntry)} → ${kstStr(now)}`);
    document.getElementById("btnChange").textContent = "변경 완료";
  } catch (e) {
    showResult("error", `오류: ${e.message}`);
    reEnableAllButtons();
  }
}
```

- [ ] **Step 3: `onCouponOnly` 구현 (스텁 교체)**

```javascript
async function onCouponOnly() {
  document.getElementById("resultBox").style.display = "none";
  disableAllButtons("btnCoupon", "쿠폰 적용 중...");
  try {
    const token = await loadToken();
    const va = await getVehicleByStatus(token, "inParking");
    if (!va) {
      showResult("nodata", `${vehicle}: 현재 입차 기록이 없습니다 (미입차)`);
      reEnableAllButtons();
      return;
    }
    if (hasFreeCoupon(va)) {
      showResult("nodata", `${vehicle}: 이미 2시간 무료 쿠폰 적용됨`);
      reEnableAllButtons();
      return;
    }
    const { nextCoupon, count } = await getNextCoupon(token);
    if (!nextCoupon) {
      showResult("nodata", `2시간 무료 쿠폰 잔여 없음 (보유 ${count}건)`);
      reEnableAllButtons();
      return;
    }
    await applyCoupon(token, va, nextCoupon);
    showResult("success", `2시간 무료 쿠폰 적용 완료 (잔여 ${count - 1})`);
    document.getElementById("btnCoupon").textContent = "쿠폰 적용 완료";
  } catch (e) {
    showResult("error", `오류: ${e.message}`);
    reEnableAllButtons();
  }
}
```

- [ ] **Step 4: `onBoth` 구현 (스텁 교체)**

```javascript
async function onBoth() {
  document.getElementById("resultBox").style.display = "none";
  disableAllButtons("btnBoth", "처리 중...");
  try {
    const token = await loadToken();
    const va = await getVehicleByStatus(token, "inParking");
    if (!va) {
      showResult("nodata", `${vehicle}: 현재 입차 기록이 없습니다 (미입차)`);
      reEnableAllButtons();
      return;
    }

    // 1) 입차시간 변경
    const now = new Date();
    const oldEntry = new Date(va.entry.accessedAt);
    await patchEntryTime(token, va, toIso(now));
    const timeChangeMsg = `${kstStr(oldEntry)} → ${kstStr(now)}`;

    // 2) 쿠폰 흐름
    if (hasFreeCoupon(va)) {
      showResult("success", `변경 완료 (쿠폰 기적용)<br>${timeChangeMsg}`);
      document.getElementById("btnBoth").textContent = "변경 완료";
      return;
    }
    const { nextCoupon, count } = await getNextCoupon(token);
    if (!nextCoupon) {
      showResult("success", `변경 완료 + 쿠폰 잔여 없음<br>${timeChangeMsg}`);
      document.getElementById("btnBoth").textContent = "변경 완료";
      return;
    }
    await applyCoupon(token, va, nextCoupon);
    showResult("success", `변경 완료 + 쿠폰 적용 완료 (잔여 ${count - 1})<br>${timeChangeMsg}`);
    document.getElementById("btnBoth").textContent = "변경 완료";
  } catch (e) {
    showResult("error", `오류: ${e.message}`);
    reEnableAllButtons();
  }
}
```

- [ ] **Step 5: `onPostPaidChange` 구현 (스텁 교체)**

```javascript
async function onPostPaidChange() {
  document.getElementById("resultBox").style.display = "none";
  disableAllButtons("btnPostPaid", "변경 중...");
  try {
    const token = await loadToken();
    const va = await getVehicleByStatus(token, "postPaid");
    if (!va) {
      showResult("nodata", `${vehicle}: 정산 대기 중인 차량이 없습니다`);
      reEnableAllButtons();
      return;
    }
    const now = new Date();
    const oldEntry = new Date(va.entry.accessedAt);
    await patchEntryTime(token, va, toIso(now));
    showResult("success", `정산 대기 차량 변경 완료<br>${kstStr(oldEntry)} → ${kstStr(now)}`);
    document.getElementById("btnPostPaid").textContent = "변경 완료";
  } catch (e) {
    showResult("error", `오류: ${e.message}`);
    reEnableAllButtons();
  }
}
```

- [ ] **Step 6: 수동 통합 검증**

브라우저 페이지 열고 실 차량으로 시나리오별 확인.

```
file:///C:/Workspace/parking-coupon/change-entry.html?vehicle=16마1011
```

확인 시나리오(스펙 §7 참조):

**inParking 케이스**
- [ ] 1번 버튼(쿠폰+변경): 쿠폰 미적용 차량 → 변경+쿠폰 둘 다 성공
- [ ] 1번 버튼: 쿠폰 기적용 차량 → "변경 완료 (쿠폰 기적용)"
- [ ] 2번 버튼(변경만): 시간만 변경 성공
- [ ] 3번 버튼(쿠폰만): 쿠폰만 적용 성공
- [ ] 3번 버튼: 쿠폰 기적용 시 nodata "이미 적용됨" + 버튼 재활성화
- [ ] 미입차 상태: 1/2/3번 모두 nodata "미입차" + 버튼 재활성화

**postPaid 케이스**
- [ ] 4번 버튼: 정산 대기 차량 입차시간 변경 성공
- [ ] 4번 버튼: postPaid 차량 없을 때 nodata + 버튼 재활성화

**UX**
- [ ] 진행 중 4개 버튼 모두 disabled
- [ ] success 시 4개 버튼 모두 disabled 유지
- [ ] nodata / error 시 4개 버튼 모두 재활성화

특히 4번 버튼은 스펙 §9 리스크에 명시한 대로 **postPaid 상태에서 입차시간 PATCH 가 서버에서 거부될 가능성** 확인 — 만약 거부되면 error 메시지 캡처 후 후속 작업 검토.

- [ ] **Step 7: 커밋**

```bash
git add change-entry.html
git commit -m "feat: change-entry 4버튼 핸들러 구현 (쿠폰/변경/정산직전)"
```

---

## Task 5: 푸시 + 운영 환경 검증

GitHub Pages 로 배포되는 페이지이므로 main 푸시 시 자동 반영. 실제 모바일에서 Slack 링크 클릭 흐름까지 확인.

- [ ] **Step 1: 푸시 전 사용자 확인**

CLAUDE.md "auto-commit, auto-push 금지" 규칙. 사용자에게 다음 사항 보고 후 진행 여부 확인:

- 변경된 파일: `change-entry.html` 1개
- 커밋 N개 (Task 1~4)
- 푸시 대상: `origin/main`

사용자 명시 승인 후에만 다음 Step.

- [ ] **Step 2: 푸시**

```bash
cd C:/Workspace/parking-coupon
git push origin main
```

- [ ] **Step 3: GitHub Pages 반영 대기 및 확인**

GitHub Pages 배포는 보통 1~2분 소요. 다음 URL로 접속하여 반영 확인.

```
https://wangbearstory.github.io/parking-coupon/change-entry.html?vehicle=16마1011
```

확인:
- 4버튼 UI 정상 표시
- 모바일 디바이스에서도 동일 확인 (Slack 링크 클릭 → 모바일 브라우저)

- [ ] **Step 4: 실 운영 시나리오 검증**

다음 자동 알림(notify-entry-change) 발송 사이클에서 실제 Slack 링크를 통한 동작 확인 — 또는 즉시 검증이 필요하면 워크플로우 수동 트리거.

```bash
gh workflow run notify-entry-change.yml --repo WangBearStory/parking-coupon
```

Slack DM 수신 → 모바일에서 링크 클릭 → 4버튼 페이지 → 1번/2번/3번 시나리오 확인.

---

## Self-Review 체크 결과

**Spec coverage:**
- §4 UI 설계 → Task 3 (CSS + 마크업)
- §5.1 공통 헬퍼 → Task 1 + Task 2
- §5.2 핸들러 4종 → Task 4
- §5.3 결과 매트릭스 11케이스 → Task 4 Step 6 검증 항목으로 모두 매핑
- §5.4 UX 처리 → Task 4 Step 1 (disable/enable 헬퍼) + Step 6 검증
- §6 에러 처리 → Task 4 각 핸들러의 try/catch + onBoth 의 "변경 후 쿠폰 실패 시 입차시간은 유지" → catch 분기 명시
- §7 테스트 시나리오 → Task 4 Step 6 + Task 5 Step 4 검증 체크리스트
- §9 리스크(postPaid PATCH 거부) → Task 4 Step 6 마지막 항목에 명시

**Placeholder scan:** "미구현 — Task 4에서 채워짐" 텍스트는 Task 3 의도된 스텁이고 Task 4 에서 모두 교체됨. 그 외 TBD/TODO 없음.

**Type consistency:** 함수명 `loadToken`, `getVehicleByStatus`, `patchEntryTime`, `hasFreeCoupon`, `getNextCoupon`, `applyCoupon`, `onBoth`, `onChangeOnly`, `onCouponOnly`, `onPostPaidChange`, `disableAllButtons`, `reEnableAllButtons`, `showResult` — 모든 Task 에서 동일 사용. 버튼 id (`btnBoth`, `btnChange`, `btnCoupon`, `btnPostPaid`) 도 Task 3/4 일치.
