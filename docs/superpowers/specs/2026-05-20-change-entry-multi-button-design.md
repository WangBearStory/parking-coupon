# change-entry.html 4버튼 확장 — Design Spec

**Date:** 2026-05-20
**Status:** Approved (사용자 승인 완료)
**Scope:** `change-entry.html` 단일 파일 수정

## 1. 배경 / 문제

`change-entry.html`은 Slack DM 링크를 타고 들어와 "현재 시간으로 변경" 버튼 한 번으로 입차시간을 현재 시각으로 PATCH 하는 페이지다. 다음 두 가지 결손이 있다.

1. **쿠폰 자동 적용 워크플로우 제거** (2026-05-20). 그동안 매일 08:17 KST에 `apply-coupon.yml`이 2시간 무료 쿠폰을 자동 적용했지만, 워크플로우와 재시도 트리거를 모두 삭제했다. 이제 사용자가 페이지에서 직접 쿠폰을 적용할 수단이 필요하다.
2. **정산기 앞에서 깜박한 케이스 미지원.** 현재 페이지는 `?status=inParking` 만 조회한다. 사용자가 입차시간 변경을 깜박하고 정산기 앞에 도착해 요금이 비싸게 나온 걸 확인한 시점에는 차량이 `postPaid`(출차정산대기) 상태로 전환되어 있어, 기존 버튼이 동작하지 않는다.

## 2. 목표

- 입차시간 변경 + 쿠폰 적용을 동시에 또는 개별적으로 사용자가 선택 가능
- 정산 직전 시점(`postPaid`)의 차량도 입차시간 변경 가능
- 모바일에서 1탭 안에 모든 버튼이 보이는 구성 유지

## 3. 비목표 (out of scope)

- 쿠폰 자동 적용 워크플로우 재도입
- Slack DM 알림 추가 (브라우저에서 토큰 노출 위험)
- `inExit` / `prePaid` 등 다른 status 지원 (운영 중 필요시 별도 작업)
- `apply-coupon.js`, `notify-entry-change.js` 수정

## 4. UI 설계

```
┌──────────────────────────────────────────┐
│  입차시간 변경                           │
│  차량번호: 16마1011                     │
│  변경 시간: 2026-05-20 14:32:05         │
│                                          │
│  [ 쿠폰 + 입차시간 변경 ]   ← primary    │
│  [ 현재 시간으로 변경 ]      ← outline   │
│  [ 2시간 무료 쿠폰 적용 ]    ← outline   │
│  ────────────────────────────            │
│  [ 정산 직전 입차시간 변경 ] ← warning   │
│                                          │
│  (결과 박스 — 공통)                     │
└──────────────────────────────────────────┘
```

- **세로 스택**, 모바일 우선
- 위 3버튼: `inParking` 대상 그룹. 첫 번째만 primary(`#00d2ff`), 나머지는 outline(투명 배경 + primary 테두리/글자색)
- 4번째 버튼: 구분선 아래에 별도 그룹. warning 색상(`#ffa726` 계열)으로 "예외 흐름" 시각 분리
- 결과 박스(`#resultBox`)는 공통. 기존 `success` / `error` / `nodata` 클래스 그대로 사용

## 5. 동작 / API 흐름

### 5.1 공통 헬퍼

| 함수 | 동작 |
|---|---|
| `loadToken()` | `POST /auth/token` → `access_token` 반환. 페이지 생명주기 동안 1회만 호출되도록 캐시 |
| `getVehicleByStatus(status)` | `GET /vehicle-accesses?siteId=…&vehicle=…&status={status}` → 첫 번째 항목 or `null` |
| `patchEntryTime(va)` | `PATCH /vehicle-accesses/{va._id}` body `{ entry: { accessedAt: nowIso, facility: va.entry.facility._id } }` |
| `hasFreeCoupon(va)` | `va.payment.discountCouponList` 중 `discountCouponKey.name`에 "방문자확인" 포함 여부 |
| `getNextCoupon()` | `GET /discount-coupon-keys/coupon?owner={OWNER_ID}&ownerModel=Admin` → `COUPON_KEY_2H`의 `nextCoupon` + `count` |
| `applyCoupon(va, couponId)` | `GET /vehicle-accesses/{va._id}` 으로 최신 `discountCouponList`(ID 배열) 확보 → 신규 ID 추가 → `PATCH … { payment: { discountCouponList: [...] } }` |

상수:
- `API_URL = "https://dev-sni-admin.eyevacs.com"`
- `SITE_ID = "SBI_EYEVACS_0032"`
- `OWNER_ID = "66a9c4f0c920064e4a47abc9"`
- `COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713"`

### 5.2 버튼별 핸들러

**onBoth() — 쿠폰 + 입차시간 변경**
1. `loadToken()` → token
2. `getVehicleByStatus("inParking")` → 없으면 `nodata` "현재 입차 기록이 없습니다" 종료
3. `patchEntryTime(va)` (실패 시 `error` 표시 + 종료, 쿠폰 시도 안 함)
4. `hasFreeCoupon(va)` true → `success` "변경 완료 (쿠폰 기적용) OLD → NEW"
5. `getNextCoupon()` → `nextCoupon` 없음 → `success` "변경 완료 + 쿠폰 잔여 없음 OLD → NEW"
6. `applyCoupon(va, nextCoupon)` → `success` "변경 완료 + 쿠폰 적용 완료 OLD → NEW"

**onChangeOnly() — 입차시간만**
1. token → `getVehicleByStatus("inParking")` → 없으면 `nodata`
2. `patchEntryTime(va)` → `success` "변경 완료 OLD → NEW"

**onCouponOnly() — 쿠폰만**
1. token → `getVehicleByStatus("inParking")` → 없으면 `nodata`
2. `hasFreeCoupon(va)` true → `nodata` "이미 2시간 무료 쿠폰 적용됨"
3. `getNextCoupon()` → 없음 → `nodata` "2시간 무료 쿠폰 잔여 없음"
4. `applyCoupon` → `success` "2시간 무료 쿠폰 적용 완료"

**onPostPaidChange() — 정산 직전**
1. token → `getVehicleByStatus("postPaid")` → 없으면 `nodata` "정산 대기 중인 차량이 없습니다"
2. `patchEntryTime(va)` → `success` "정산 대기 차량 변경 완료 OLD → NEW"

### 5.3 결과 매트릭스 (확정)

| 버튼 | 케이스 | 클래스 | 메시지 |
|---|---|---|---|
| 1 / 2 / 3 | inParking 차량 미입차 | nodata | "현재 입차 기록이 없습니다" |
| 1 | 변경 + 쿠폰 적용 | success | "변경 완료 + 쿠폰 적용 완료 OLD → NEW" |
| 1 | 변경 + 쿠폰 기적용 | success | "변경 완료 (쿠폰 기적용) OLD → NEW" |
| 1 | 변경 + 쿠폰 잔여 없음 | success | "변경 완료 + 쿠폰 잔여 없음 OLD → NEW" |
| 1 | 변경 실패 | error | API 오류 메시지 |
| 2 | 변경 성공 | success | "변경 완료 OLD → NEW" |
| 3 | 쿠폰 이미 적용됨 | nodata | "이미 2시간 무료 쿠폰 적용됨" |
| 3 | 쿠폰 잔여 0건 | nodata | "2시간 무료 쿠폰 잔여 없음" |
| 3 | 쿠폰 적용 성공 | success | "2시간 무료 쿠폰 적용 완료" |
| 4 | postPaid 차량 없음 | nodata | "정산 대기 중인 차량이 없습니다" |
| 4 | 변경 성공 | success | "정산 대기 차량 변경 완료 OLD → NEW" |
| 1-4 | 기타 API 오류 | error | `오류: HTTP {status}: {body}` |

### 5.4 UX 처리

- 어느 버튼이든 진행 중에는 **4개 버튼 전부 disabled** + 클릭된 버튼 텍스트는 "처리 중..." 표시
- 종료 후 결과 박스 표시. 이후 버튼 상태:
  - **success**: 클릭된 버튼 텍스트 "변경 완료" / "쿠폰 적용 완료" 등으로 고정, 4개 버튼 모두 disabled 유지 (재시도 방지)
  - **nodata** (미입차 / 정산 대기 차량 없음 / 쿠폰 기적용 / 쿠폰 잔여 없음): 4개 버튼 모두 다시 활성화, 텍스트 원복 (기존 코드의 `btn.disabled = false; btn.textContent = "현재 시간으로 변경"` 패턴과 동일)
  - **error**: 4개 버튼 모두 다시 활성화, 텍스트 원복 (재시도 가능)

## 6. 에러 처리

- API HTTP non-2xx → `apiRequest` 가 `Error` throw, 호출부에서 catch → `result error` 박스
- 토큰 실패 시 첫 버튼 클릭에서 바로 error
- onBoth 에서 `patchEntryTime` 성공 후 쿠폰 단계가 실패하면 → 입차시간은 변경된 상태로 두고 error 표시 (사용자는 다시 3번 버튼으로 재시도 가능)

## 7. 테스트 시나리오

수동 검증(스테이징 또는 실 환경):

1. **inParking 케이스 (Slack 링크 시나리오)**
   - [ ] 1번 버튼: 차량 입차 + 쿠폰 미적용 상태에서 변경+쿠폰 둘 다 성공
   - [ ] 1번 버튼: 차량 입차 + 쿠폰 이미 적용된 상태 → "기적용" 메시지
   - [ ] 2번 버튼: 입차시간 변경만 동작 확인
   - [ ] 3번 버튼: 쿠폰만 적용 확인
   - [ ] 차량 미입차 상태: 1/2/3번 모두 nodata "미입차" 표시
2. **postPaid 케이스 (정산기 앞 시나리오)**
   - [ ] 4번 버튼: 정산 대기 상태의 차량에서 입차시간 PATCH 성공
   - [ ] 4번 버튼: postPaid 차량 없을 때 nodata 표시
3. **UI 회귀**
   - [ ] 모바일 폭(375px)에서 4개 버튼 + 결과박스 모두 1탭 안에 보임
   - [ ] 진행 중 4개 버튼 모두 disabled
   - [ ] `?vehicle=` 미지정 시 기존 에러 표시 유지

## 8. 변경 범위

| 파일 | 변경 |
|---|---|
| `change-entry.html` | UI(버튼/CSS) + 스크립트 핸들러 4종 |
| 기타 | 없음 |

## 9. 리스크 / 미해결

- **`postPaid` 상태에서 입차시간 PATCH가 서버에서 거부될 가능성:** 메모리(`parking-skill.md`)에 "이미 정산된 차량은 할인권을 수정할 수 없습니다" 노트가 있으나 이는 쿠폰 PATCH에 대한 것. 입차시간 PATCH가 postPaid에서도 통과되는지는 실측 필요. 거부될 경우 4번째 버튼은 사용자에게 error 메시지로 노출되며, 후속 작업으로 fallback(`inExit` 등) 시도 보강 검토.
- **쿠폰 잔여 0건 케이스:** 현재 1번 버튼에서 "변경 완료 + 쿠폰 잔여 없음" 메시지로 처리하지만, 사용자가 잔여를 직접 충전해야 함. 자동 충전 흐름은 별도 작업.
