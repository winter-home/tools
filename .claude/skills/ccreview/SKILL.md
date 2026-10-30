---
name: ccreview
description: "단일 커밋 또는 지정한 커밋 범위의 최종 누적 변경을 일반적인 코드 리뷰 기준으로 검토한다. 과거 tree나 임의 Git 범위 리뷰에 사용한다."
disable-model-invocation: true
argument-hint: "<커밋 범위 | 단일 커밋> [리뷰 집중 영역 (선택)]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git *)
---

# 커밋 범위 코드 리뷰

사용자가 호출 시 제공한 인자(`$ARGUMENTS`)로 지정한 단일 커밋 또는 커밋 범위를 하나의 최종 누적 변경으로 리뷰한다. 범위가 없거나 여러 의미로 해석되면 리뷰 전에 사용자에게 확인한다. 리뷰만 수행하고 파일은 수정하지 않는다.

## 범위 확정

- 단일 ref `X`: `git diff X^..X`. 루트 커밋이면 빈 tree부터 `X`까지 비교한다. merge commit은 사용자가 다른 부모를 지정하지 않은 한 첫 부모를 기준으로 한다.
- 명시적 `A..B`, `A...B`, `A^..B` 또는 `git diff <range>`: 사용자가 적은 범위와 방향을 그대로 사용한다.
- `A부터 B까지`, `A ~ B` 같은 자연어 inclusive 범위: 양방향 `git merge-base --is-ancestor`로 오래된 쪽과 최신 쪽을 정한 뒤 `<old>^..<new>`를 사용한다. 어느 쪽도 ancestor가 아니면 비교 기준을 사용자에게 확인한다. `<old>`가 루트 커밋이면 빈 tree를 기준으로 한다.

사용할 ref가 존재하는지 `git rev-parse --verify`로 검증한다. 확정한 범위에 `git log --oneline --reverse`, `git diff --stat`, `git diff --name-status`, `git diff`를 적용해 포함 커밋과 최종 누적 변경을 수집한다. 변경이 없으면 "변경 사항 없음"을 보고하고 종료한다.

## 최종 tree 기준

리뷰 대상은 개별 커밋 과정이 아니라 범위 종료 시점의 최종 코드다. 종료 커밋이 현재 checkout과 다르거나 working tree에 미커밋 변경이 있으면 `git show <end>:<path>`와 `git grep <pattern> <end>`를 사용해 종료 커밋의 파일, 호출부, 테스트를 확인한다. 삭제 파일은 비교 기준 tree에서 삭제 전 맥락을 확인한다. working tree 내용과 대상 커밋의 내용을 섞지 않는다.

변경 파일에 적용되는 루트 및 하위 경로의 `AGENTS.md`와 `CLAUDE.md`를 읽고, 여기서 연결한 관련 문서가 변경 판단에 필요하면 확인한다. 공개 심볼이나 데이터 계약이 바뀌었다면 필요한 소비처까지 추적한다.

## 리뷰

`../creview/references/review-guidelines.md`를 완전히 읽고 그 기준을 적용한다. `creview`의 working tree 범위 수집 절차는 적용하지 않는다.

결과 상단에 사용자 입력 범위, 실제 사용한 diff 명령, 종료 커밋을 적은 뒤 공통 리뷰 기준에 따른 발견 사항을 제시한다.
