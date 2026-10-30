---
name: creview
description: "미커밋된 staged 및 unstaged tracked 변경을 일반적인 코드 리뷰 기준으로 검토한다. 커밋 전 로컬 변경 점검에 사용한다."
disable-model-invocation: true
argument-hint: "[리뷰 집중 영역 (선택)]"
allowed-tools: Read Grep Glob Bash(git *)
---

# 미커밋 코드 리뷰

staged 변경과 unstaged tracked 변경을 하나의 누적 변경으로 리뷰한다.

- untracked 파일과 이미 커밋된 변경은 제외한다.
- 사용자가 호출 시 제공한 집중 영역(`$ARGUMENTS`)이 있으면 해당 관점을 우선하되 전체 변경의 중대한 문제도 놓치지 않는다.
- 리뷰만 수행하고 파일은 수정하지 않는다.

## 범위 수집

`git status --short`, `git diff --staged`, `git diff`로 범위를 확정한다. 대상 변경이 없으면 "변경 사항 없음"을 보고하고 종료한다.

변경 파일에 적용되는 루트 및 하위 경로의 `AGENTS.md`와 `CLAUDE.md`를 읽고, 여기서 연결한 관련 문서가 변경 판단에 필요하면 확인한다. diff만으로 판단하기 어려운 경우 변경 주변 코드, 호출부, 공개 계약, 테스트를 필요한 만큼 추적한다.

## 리뷰

`references/review-guidelines.md`를 완전히 읽고 그 기준을 적용한다.
