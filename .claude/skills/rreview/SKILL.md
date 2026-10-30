---
name: rreview
description: "미커밋 변경을 새 세션의 codex·claude 리뷰어(creview·sreview)로 한 번 병렬 리뷰하고, 지적이 있으면 vreview 절차로 검증한 보고서를 출력한다. 코드는 수정하지 않는다."
disable-model-invocation: true
argument-hint: "[리뷰어 구성 3자리, 각 0~2 (기본 200)] [리뷰 집중 영역 (선택)]"
allowed-tools: Read Grep Glob Write Bash(git *) Bash(pwsh -NoProfile -File *run-reviewers.ps1*) PowerShell(git *) PowerShell(pwsh -NoProfile -File *run-reviewers.ps1*)
---

# rreview — 병렬 리뷰·검증

staged·unstaged tracked 변경을 새 세션 리뷰어들이 병렬로 한 번 리뷰하고, 이 세션이 그 결과를 vreview 절차로 검증한 보고서를 출력한다. 권장안은 적용하지 않으며 `git add -N` 외의 stage·커밋은 하지 않는다.

## 인자

첫 인자가 숫자 세 자리이면 리뷰어 구성이다. 각 자리는 해당 리뷰어의 개수(0~2)다.

| 자리 | 리뷰어                     |
| ---- | -------------------------- |
| 1    | codex 새 세션의 `creview`  |
| 2    | claude 새 세션의 `creview` |
| 3    | claude 새 세션의 `sreview` |

- 숫자가 없으면 `200`. 어느 자리든 2를 넘거나 합계가 0이면 오류로 종료한다.
- 나머지 인자는 리뷰 집중 영역이다.
- 리뷰어는 모두 서로 다른 새 세션이다.

## 준비

1. `git status --short`로 대상을 확인한다. staged·unstaged tracked 변경이 없으면 종료한다.
2. 리뷰어는 untracked 파일을 보지 않는다. 이번 작업에서 만든 untracked 파일은 `git add -N`으로 리뷰 범위에 넣고, 무관한 파일은 건드리지 않는다.
3. 실행 디렉터리를 만든다: `tmp/rreview/<yyyyMMdd-HHmmss>`
4. 실행 디렉터리의 `brief.md`에 리뷰어가 알 수 없는 맥락을 쓴다: 사용자 요청 요약, 합의한 동작·결정, 의도적으로 제외한 범위, 리뷰 집중 영역. 리뷰어는 이 대화를 보지 못하므로 sreview의 범위 판단은 이 파일에 의존한다.

## 리뷰

### 1. 리뷰어 실행

저장소 루트에서 실행한다. 결과 디렉터리는 실행 디렉터리다.

```
pwsh -NoProfile -File "<rreview 스킬 디렉터리>/scripts/run-reviewers.ps1" -Spec <구성> -OutDir "<결과 디렉터리>" -BriefFile "<실행 디렉터리>/brief.md"
```

- 모든 리뷰어가 끝날 때까지 기다린 뒤 `summary.json`을 출력한다. 리뷰어 하나가 수십 분 걸릴 수 있으므로 Claude Code에서는 백그라운드로 실행하고 완료 알림을 기다린다. 폴링하지 않는다. 백그라운드 완료 알림이 없는 에이전트는 타임아웃을 `-TimeoutMinutes`보다 길게 잡고 블로킹으로 실행한다.
- 도구 대기 시간이 그보다 짧으면 스크립트를 분리 프로세스로 띄우고, 도구 제한 안의 대기를 반복해 프로세스가 끝나기를 기다린다. 끝난 뒤 `summary.json`이 없으면 실패로 보고한다.

  ```
  (Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -File "<스크립트>" -Spec <구성> -OutDir "<결과 디렉터리>" -BriefFile "<brief>"').Id
  Wait-Process -Id <PID> -Timeout 240 -ErrorAction SilentlyContinue
  ```
- 리뷰어가 도는 동안 작업 트리를 수정하지 않는다.
- 선택 옵션: `-CodexModel`(기본 `~/.codex/config.toml`의 `model`), `-ClaudeModel`(기본 `opus`), `-CodexSandbox`(기본 `read-only`), `-TimeoutMinutes`(기본 60).
- Windows의 codex 샌드박스는 Microsoft Store판 pwsh를 실행하지 못한다. 스크립트는 Store판이 아닌 pwsh(PATH 또는 Codex 앱 번들)를 codex의 PATH 맨 앞에 둔다. 찾지 못하면 경고를 출력하며, codex 리뷰어는 셸 명령을 실행하지 못한다.
- `danger-full-access`는 Claude Code auto 모드 분류기가 실행을 막을 수 있으므로 사용자가 요청할 때만 쓴다.

### 2. 실행 결과 확인

- `ok`가 false인 리뷰어(시작 실패·비정상 종료·타임아웃·빈 출력)는 `log` 끝부분으로 원인을 확인해 보고에 남기고 이번 검증에서 제외한다. 전부 실패하면 중단한다.
- tracked 변경이 있는데 "변경 사항 없음"으로 끝난 리뷰는 실패로 취급한다.

### 3. 지적 정리

성공한 리뷰어의 출력(`summary.json`의 `output`)을 읽고 리뷰어별로 정리해 보여 준다. 지적마다 `심각도 파일:라인 요지`를 제목으로 쓰고 문제·근거·제안을 각 1~2문장으로 요약한다. 심각도는 creview 지적에만 붙이고 판정은 붙이지 않는다. 지적이 없는 리뷰어는 "지적 없음"으로 적는다.

### 4. 검증

정리한 지적이 있으면 `../vreview/SKILL.md`를 읽고 그 절차로 전부를 한 번에 검증해 보고서를 보여 준다. 여러 리뷰어의 같은 지적은 묶어서 한 번 판정한다. 지적이 없으면 그렇게 보고한다.

3·4의 정리와 보고서는 진행 메시지로 줄이지 않고 정한 형식 그대로 출력한다. 이어서 작업하는 중간 출력이어도 같다.

## 최종 보고

- 실행한 리뷰어(실패와 원인 포함)
- 리뷰어별 지적 정리
- vreview 보고서 또는 지적 없음
- 실행 디렉터리 경로
