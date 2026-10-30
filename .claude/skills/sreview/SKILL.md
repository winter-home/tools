---
name: sreview
description: "미커밋된 staged 및 unstaged tracked 변경에 불필요한 구현·테스트 확장이 있는지 검토한다. 요청 범위와 동작을 유지하면서 단순화할 수 있는지 점검할 때 사용한다."
disable-model-invocation: true
argument-hint: "[리뷰 집중 영역 (선택)]"
allowed-tools: Read Grep Glob Bash(git status *) Bash(git diff *) Bash(git show *)
---

# 변경 범위·간결성 리뷰

리뷰만 수행하며 파일 수정·stage·빌드·테스트는 하지 않는다.

## 범위 확인

- `git status --short`, `git diff HEAD`로 staged·unstaged tracked 변경의 최종 누적 상태를 확인한다. untracked와 이미 커밋된 변경은 제외하며, 대상 변경이 없으면 이를 보고하고 종료한다.
- 사용자의 최신 요청·합의한 동작을 기준으로 삼고, 집중 영역(`$ARGUMENTS`)이 있으면 그 영역을 우선 검토한다.
- 적용되는 `AGENTS.md`·`AGENTS.override.md`·`CLAUDE.md`와 연결된 관련 규칙을 확인하고, 판단에 필요한 주변 코드·호출부·기존 테스트를 추적한다.

## 리뷰

`references/simplicity-guidelines.md`를 완전히 읽고 그 기준을 적용한다.
