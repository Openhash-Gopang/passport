# Pathfinder — 요청 경로 최적화 설계

**문서 성격**: Phase 0의 "최대 장점"(제출 이력 축적, README/ROADMAP 참고)을 실제 최적화
문제로 정식화한 설계안. 원래는 `pdv_records`를 데이터 원천으로 전제했으나, hondi(구 gopang)
저장소 실사 결과 실제 원천은 `dept_tasks`(부서/기관 간 업무지시 큐)이며, 계측 자체가 아직
부족해 신규 이벤트 로그 설계가 선행돼야 한다는 점이 1장에 반영돼 있다. IDV/민간 축 설계와는
독립적인 별도 트랙이다.

## 문제 정의

모든 사용자 요청은 최소 1개 이상의 기관, 1개 이상의 부서, 1명 이상의 사람 직원을 거쳐 결과물에
도달한다. 각 요청이 결과물에 이르는 경로가 존재하고, 그 경로는 처리 시간을 기준으로 거리가
측정되며, 전체 요청의 합산 거리(시간)를 추산할 수 있다. Pathfinder는 머신러닝으로 이 합산
거리를 최소화하는 지점을 찾는다.

예: 2025년 1천만 명이 1억 건의 요청을 했다면, 각 요청의 경로·구간별 처리시간이 이미
`pdv_records`에 기록돼 있고, 이 전체 데이터에서 병목 구조와 최적 배정을 도출한다.

## 1. 데이터 모델 — 실사 결과와 계측 공백 (2026-08-13 확정)

당초 "기존 `pdv_records`를 그래프로 ETL 매핑"을 전제했으나, hondi(구 gopang) 저장소 실사 결과
전제가 틀렸다. 아래 실사 결과를 기준으로 데이터 모델을 다시 정의한다.

### 1.1 실사 결과

| 컬렉션 | 실제 성격 | Pathfinder 적합성 |
|---|---|---|
| `pdv_records`(GOV_TASK, `summary_6w.gov_task`) | 시민이 **한 기관**에 서류를 접수하는 **단발성 이벤트**(accepted/보완필요). `where`도 기관 단위뿐, 부서·담당자 구분 없음, 처리시간 필드 없음 | 부적합 — 경로 자체가 없음 |
| `dept_tasks`(부서/기관 간 업무지시 큐) | `requester_type/id → target_type/id`, `status`(requested→acknowledged→in_progress→completed→rejected), **`origin_chain`**(지금까지 거친 target_id 누적 배열, 순환 위임 방지용) | Pathfinder가 필요로 하는 "여러 기관/부서를 거치는 경로"에 훨씬 가까움 — **주 데이터 원천으로 채택** |

### 1.2 발견된 계측 공백

1. **단계별 소요시간 이력이 저장되지 않음**: `_l1UpdateDeptTask()`가 상태 전이를 **같은 레코드에
   PATCH**로 덮어쓴다 — `updated` 필드는 마지막 전이 시각만 남고, "requested→acknowledged
   몇 분", "acknowledged→in_progress 몇 시간" 같은 구간별 소요시간은 유실된다. 지금 상태로는
   최종 소요시간(생성~완료)만 알 수 있지, 어느 구간이 병목인지 알 수 없다
2. **담당자(직원) 단위 데이터 없음**: `target_type`은 `dept/org/business/national/k-service`
   까지만 있고 개인 직원 식별자가 없다
3. **GOV_TASK ↔ dept_tasks 연결고리 없음**: 시민 접수(GOV_TASK)와 기관 내부 처리(dept_tasks)가
   코드상 분리돼 있어, 시민 요청 하나가 내부적으로 어떤 경로를 거쳤는지 지금은 재구성할 수 없다

### 1.3 결론 — ETL이 아니라 계측(instrumentation) 신설이 먼저

1단계 착수 항목은 "기존 데이터 매핑"에서 **"이벤트 로그 신설"**로 바뀐다.

- **`dept_task_events`(신설, append-only 로그)**: `dept_tasks` 상태 전이마다 새 행 추가 —
  `task_id, from_status, to_status, at, actor_hash(선택)`. 기존 PATCH 방식은 그대로 두고,
  PATCH 직전에 이벤트 로그를 남기는 후크만 추가 — 기존 로직 변경 최소화
- **GOV_TASK ↔ dept_tasks 연결 필드**: `dept_tasks.payload`(JSON, 기존 필드)에
  `origin_pdv_report_id`를 넣어, 시민 접수 시점부터 내부 처리까지 하나의 경로로 연결
- **담당자 단위는 당장 보류**: 현재 스키마에 아예 없어 새 필드 + 동의 절차가 필요 — Pathfinder
  v1(부서 단위 병목 리포트)에는 없어도 되므로 이후 과제로 미룸

### 1.4 그래프 모델 (계측 신설 이후 기준으로 수정)

```
노드(Node) = (task_type, target_type, target_id)         # 담당자 단위는 v2 이후
간선(Edge) = dept_task_events의 연속된 두 상태 전이 사이 구간, 가중치 = (to.at - from.at)
경로(Path) = origin_chain 순서대로 이어지는 노드 시퀀스, GOV_TASK 접수 시점을 시작점으로
```

- `task_type`이 다르면 사실상 다른 부분그래프 — 하나의 거대 그래프에 함께 두되 `task_type`을
  노드 식별자에 포함해 절차 간 경로가 섞이지 않게 한다
- 간선 가중치는 정적 평균이 아니라 예측값을 사용한다(2장 참고) — 단, `dept_task_events` 축적이
  일정 기간 쌓이기 전까지는 예측 대신 단순 관측 평균으로 시작한다

## 2. 1단계 — 라우팅 최적화 (구조 고정, 배정만 최적화)

절차 구조는 그대로 두고, 여러 유효 경로가 존재하는 지점(동일 업무 처리 가능한 담당자·부서가
복수인 경우)에서 배정만 최적화한다.

### 2.1 가중치 예측
간선 가중치(처리시간)를 과거 평균으로 고정하지 않고 회귀 모델(gradient boosting 등)로
예측한다.
- 특징값: 요일/시간대, 현재 적체 건수, 담당자 경력(PDV 이력에서 유추), 요청 복잡도(첨부서류
  개수 등)
- 목적: "지금 이 순간 가장 빈 경로"로 동적 라우팅 가능

### 2.2 전역 최적화
예측된 가중치로 개별 요청은 최단경로(Dijkstra류)면 되지만, 동시에 여러 요청이 들어올 때
개별 최단경로의 합이 전체 최적이 아닐 수 있다(다들 "가장 빠른 담당자"로 몰리면 그 담당자가
새 병목이 됨). 실제로는 **최소비용흐름(min-cost flow)** 문제로 정식화해, 다수 요청을 동시에
배정하는 전역 최적화를 수행한다.

### 2.3 procedure_maps 통합 — 기존 AI비서 호출 메커니즘과의 연결점 (2026-08-13 확정)

실사 결과, "AI비서가 매 요청마다 새 경로를 찾지 않고 검증된 경로를 인출"하는 메커니즘은
이미 존재한다 — `K-Compose`(SP-20) STEP 1이 `procedure_maps.goal`로 캐시를 조회해
hit(status:active)이면 즉시 재사용하고, miss면 STEP 1-B(최초 조사) 후 신규 등재한다.
`procedure_maps.steps`는 `[{seq, atom_id, org_id, condition, parallel_group, ...}, ...]`
형태의 JSON 배열로, "이 목표를 이루려면 어느 기관·절차를 거쳐야 하는가"라는 **구조**를
캐싱한다.

다만 이 캐시엔 **시간 차원이 없다** — `procedure_maps`/`org_profiles`/`atom_rows` 스키마
전수 확인 결과 처리시간·소요시간 관련 필드가 전혀 없다. Pathfinder가 이 구조 캐시와
경쟁하는 별도 캐시를 새로 만들 이유는 없고, 대신 **이 캐시가 원래 갖지 못한 "시간" 차원을
공급하는 계층**으로 자리잡는다.

**결정된 통합 방식**: `procedure_maps.steps`의 각 step 객체에 `pathfinder` 서브필드를
신설한다.

```json
{
  "seq": 1,
  "atom_id": "court-filing",
  "org_id": "court-seoul-rehab",
  "pathfinder": {
    "predicted_duration_sec": 259200,
    "sample_size": 47,
    "confidence": "medium",
    "computed_at": "2026-08-13",
    "source": "dept_task_events_aggregate"
  }
}
```

- `predicted_duration_sec`/`sample_size`/`confidence`: 2.1의 회귀 모델 산출값 — 표본이
  적으면(`sample_size` 낮음) `confidence: low`로 표시해 K-Compose가 과신하지 않게 한다
- `computed_at`: `org_profiles.as_of_date`와 같은 관례(정적 정보 최신성 표기)를 시간
  가중치에도 그대로 적용
- `source`: 값의 출처를 명시(향후 다른 산출 방식이 추가될 수 있으므로)
- **프라이버시**: 이 필드는 집계된 예측값만 담는다 — `origin_pdv_report_id`나 GUID 등
  개별 식별 정보는 절대 포함하지 않는다(6장 화이트리스트 쿼리 원칙과 동일)

**갱신 주기**: 실시간 계산이 아니라, v1(배치 리포트, 8장 3번) 산출물이 주기적으로
`procedure_maps.steps[].pathfinder`를 갱신해 쓰는 방식 — K-Compose STEP1 캐시 조회는
그대로 유지하면서 조회 결과에 이미 최신 가중치가 실려 있게 한다

**해결되지 않은 연결고리 (다음 결정 필요)**: `procedure_maps.steps[].atom_id`/`org_id`와
Pathfinder의 집계 키(`dept_tasks.task_type` × `target_id`)가 서로 다른 이름공간이다 —
atom_id는 `atom_rows`(REPORT/DECISION/PAY/QUERY/ADJUDICATE 패턴 카탈로그) 소속이고,
dept_task는 GOV_TASK의 `agency`/`task_key`에서 파생된다. 이 둘을 잇는 명시적 매핑(또는
정규화 규칙)이 아직 없다 — atom_id 실행이 실제로 어떤 GOV_TASK(agency/task_key)를
호출하는지는 `_execReport`/`_execDecision` 등 실행부 코드마다 다르게 구현돼 있어, 이
매핑을 먼저 확정해야 `predicted_duration_sec`를 실제로 채울 수 있다

**2.2(전역 최적화, min-cost flow)와의 관계**: 이 확장은 K-Compose의 "단건 캐시 조회"
시점에 가중치를 얹어주는 것까지다 — 동시에 들어오는 여러 요청을 함께 조율하는 진짜
전역 최적화(2.2)는 캐시 조회만으로는 안 되고, 별도의 실시간 배정 서비스(v3, 4장 참고)가
필요하다는 한계는 그대로 남는다. 즉 이번 통합은 v1→v2(라우팅 힌트) 전환의 구체적
구현 지점이지, v3(전역 최적화)를 대체하지 않는다.



구조 자체가 바뀔 수 있다는 전제 하에, 그래프 분석 기법으로 "무엇을 바꿀지"를 찾는다.

| 기법 | 찾아내는 것 |
|---|---|
| 매개 중심성(betweenness centrality) | 유난히 많은 경로가 강제로 거쳐가는 병목 노드/부서 |
| 절단점(cut vertex) 분석 | 우회 불가능한 단일 실패점(SPOF) — 유일 경로인 부서 |
| 패턴 유사도(서류 요건 벡터 비교) | 서로 다른 절차 단계가 사실상 동일 서류를 요구하는 중복 요구 후보 |
| 반사실 시뮬레이션(counterfactual) | 특정 노드 제거/병합 시 전체 합산 시간 절감 추정치 |

## 4. 산출물 — 단계적 발전 경로

| 버전 | 형태 | 내용 |
|---|---|---|
| v1 | 정기 배치 리포트(분기 등) | 병목 부서 랭킹, 중복 요구 후보, 구조 변경 시 예상 절감 시간(신뢰구간 포함) — 정책 담당자용 |
| v2 | 라우팅 힌트 | 여러 유효 경로가 있을 때 "이쪽이 예상 처리시간이 짧습니다"를 혼디 시스템에 제안(자동 확정 아님) |
| v3 | 실시간 자동 라우팅 | min-cost flow 결과를 GOV_TASK 배정 로직에 실제 반영, 지속 학습(피드백 루프) |

v1→v2→v3는 리스크가 커지는 순서다. v1은 사람이 보는 참고자료라 실패해도 무해하지만, v3는
실제 처리시간에 직접 개입하므로 예측 모델의 신뢰도가 충분히 검증된 뒤에만 전환한다.

## 5. 프라이버시

노드·간선은 전부 집계 단위다 — 개별 사용자 식별자는 그래프에 들어가지 않는다. 기존 원칙대로
`hash(userGuid+salt)` 가명화 후에도 경로 통계에만 기여하고 개별 조회는 불가능하게 설계한다.
`dept_task_events`의 `actor_hash`(선택 필드, 담당자 단위 v2 이후 도입)도 동일 원칙 적용 —
"누가 느린가"가 아니라 "어느 단계가 느린가"에 집중한다. 인사평가 도구로 오용되는 것을 원천
차단하는 설계다.

## 6. 가명화 파이프라인 검증

Pathfinder의 그래프 집계 파이프라인은 개별 사용자 식별 없이 병목·패턴만 노출해야 한다. 이
원칙을 실제로 만족하는지 확인하기 위한 검증 설계.

### 6.1 알려진 위험 — pdvReportId 자체의 GUID 평문 포함

GOV_TASK 접수 시 생성되는 `pdvReportId` 문자열(`govtask:${agency}:${task_key}:${guid}:${Date.now()}`)은
설계 초기부터 원본 GUID를 평문으로 포함하고 있다. `dept_tasks.payload.origin_pdv_report_id`에
이 값이 그대로 들어가므로, Pathfinder 집계 파이프라인이 `payload` 필드를 그대로 읽으면
가명화가 무의미해진다. (실제로 `feat/govtask-depttask-link` 브랜치의 최초 패치는
`payload.origin_guid`에 GUID를 한 번 더 평문으로 넣는 실수까지 있었고, 이후 수정 커밋으로
제거했다 — 8장 2번 항목 참고.)

- **원칙**: Pathfinder 집계 쿼리는 `dept_tasks`/`dept_task_events`에서 `payload`,
  `directive`, `result_note`, `requester_label` 필드를 **절대 SELECT하지 않는 화이트리스트
  쿼리**로만 접근한다 — `task_type`, `target_type`, `target_id`, `status`, `origin_chain`,
  `from_status`, `to_status`, `at` 등 집계에 필요한 필드만 명시적으로 선택한다
- `dept_tasks`/`dept_task_events`는 이미 `listRule`/`viewRule`/`createRule: null`로 admin
  전용 접근 제한이 걸려 있음(원본 테이블 접근 통제 자체는 이미 충족). 다만 이는 "누가 테이블에
  접근할 수 있는가"의 통제이지 "집계 파이프라인이 어떤 컬럼을 읽는가"의 통제는 아니므로,
  화이트리스트 쿼리 원칙은 별도로 강제돼야 한다

### 6.2 자동 테스트 3종

1. **역추적 스캔(reverse-trace scan)**: 집계 파이프라인의 출력(병목 리포트, 그래프 통계)에서
   임의의 GUID·GOV_TASK 접수번호·사용자 식별 가능 문자열을 정규식/사전 매칭으로 스캔 — 하나라도
   검출되면 실패. 화이트리스트 쿼리를 우회해 `payload` 등이 실수로 집계에 섞여 들어가는 경우를
   잡기 위한 최종 방어선
2. **k-익명성 검증(k ≥ 5)**: 리포트에 노출되는 모든 집계 단위(예: 특정 `task_type` ×
   `target_id` × 기간)가 최소 5건 이상의 서로 다른 원본 요청을 포함하는지 확인 — 미달 시 해당
   행은 리포트에서 제외하거나 상위 단위로 병합
3. **인접정보 결합공격 시뮬레이션**: 리포트에 등장하는 여러 집계 필드(부서, 시간대, 처리시간
   구간 등)를 교차 결합했을 때 특정 개인·업체로 좁혀지는 조합이 있는지 시뮬레이션 — 예를 들어
   "특정 부서 + 특정 날짜 + 특정 처리시간 구간"이 사실상 한 건만 가리키는 경우를 탐지

### 6.3 수동 점검 항목

- 신규 집계 쿼리를 추가할 때마다 화이트리스트 필드 목록에 없는 컬럼을 참조하는지 코드 리뷰에서
  확인
- 리포트 출력 포맷에 자유 텍스트 필드(예: `directive`, `result_note`)가 그대로 노출되는 경로가
  없는지 확인
- `actor_hash`(v2 이후 도입 예정) 추가 시, 담당자 식별로 역산 가능한 salt 관리 방식 재검토

### 6.4 구현 상태

이 절의 자동 테스트 3종은 설계만 완료됐고 코드 구현은 아직 없다 — v1 배치 리포트 프로토타입
착수 전에 반드시 구현해 CI에 포함시킨다.

## 7. G18 HUMAN-AUTHORITY-GATE와의 관계

Pathfinder는 배정을 최적화할 뿐, 승인 권한 자체를 건드리지 않는다. "규칙형 vs 재량형" 절차
구분(THOUGHT_EXPERIMENT 문서 참고)이 여기서도 적용된다:

- **규칙형 절차**: 라우팅 최적화·구조 개선 제안 모두 적용 대상
- **재량형 절차(G18 대상)**: 라우팅 대상에서 제외하거나, 최적화 목표를 "처리시간 최소화"가
  아니라 "적정 검토시간 확보"로 다르게 설정 — 재량형 절차를 무리하게 빠르게 배정하면
  즉흥적 승인을 유도하는 부작용이 생길 수 있다

## 8. 다음 단계 (제안, 2026-08-13 수정)

1. ~~`dept_task_events` 스키마 설계·마이그레이션~~ — **완료(2026-08-13, gopang main 브랜치에
   push됨)**: `_l1UpdateDeptTask()`/`createDeptTaskCore()` 호출 직전 후크로 이벤트 로그 적재,
   기존 `dept_tasks` 로직 변경 없이 병행 적재
2. ~~GOV_TASK ↔ dept_tasks 연결 필드 추가~~ — **완료(2026-08-13, gopang
   `feat/govtask-depttask-link` 브랜치에 push, main PR 대기 중)**: `payload.origin_pdv_report_id`
   반영. 최초 패치는 `payload.origin_guid`(평문 GUID)도 함께 넣는 실수가 있었으나 이후 수정
   커밋으로 제거함 — 6.1 참고
3. 이벤트 로그가 일정 기간(최소 1~2개월) 쌓인 뒤, v1(배치 리포트) 프로토타입 착수 — 소규모
   `task_type` 1~2개로 병목 분석 파일럿. **아직 착수 전(데이터 축적 대기 중)**
4. 6장의 자동 테스트 3종(역추적 스캔, k-익명성 검증, 결합공격 시뮬레이션) 구현 — v1 착수 전
   선행 조건, **아직 코드 구현 없음(설계만 완료)**
