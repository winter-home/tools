# Tools

## Project Overview

다른 프로젝트에서 쓸 범용 도구를 만든다.

## Mandatory Constraints

### Git 작업

- 현재 작업 브랜치를 유지한다. 시험·CI 실행을 이유로 새 브랜치를 만들거나 체크아웃하지 않으며, 브랜치 변경은 사용자가 직접 요청한 경우에만 수행한다.
- 완료 후 필요한 추적 파일만 stage하고 자동 커밋·푸시하지 않는다. 단, `iplan`의 통과한 단계와 `lreview` 「복구」의 통과한 세부 단계는 커밋한다. ignored 파일은 요청 없이 강제 추가하지 않는다.

## Available CLI Tools

`jq`, `sqlite3`, `rg`, `fd`, `curl`, `rclone`, `pymobiledevice3`