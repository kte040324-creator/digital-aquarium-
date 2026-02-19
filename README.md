# Hand Gallery (MediaPipe)

웹캠에서 **손(HandLandmarker)** 를 추적해서,
**검지 끝을 커서처럼** 사용하고 **엄지+검지 pinch(집기)** 로 갤러리 아이템을 **선택/드래그**하는 데모입니다.

## 실행

```bash
cd hand-gallery

yarn install
yarn dev
```

브라우저에서 카메라 권한을 허용하면 바로 시작됩니다.

## 동작 방식(요약)

- **커서**: index finger tip(랜드마크 8) 좌표를 화면 좌표로 매핑
- **클릭/드래그 트리거**: thumb tip(4) ↔ index tip(8) 거리로 pinch 판정
- **갤러리 인터랙션**: pinch 시작 시 hovered 아이템을 “잡고”, pinch 유지 동안 아이템 좌표 업데이트

## 배포(Deploy)

카메라/MediaPipe는 **HTTPS** 환경에서 안정적으로 동작합니다(로컬호스트는 예외).

### Vercel

- 프로젝트 import 후
  - **Build Command**: `yarn build`
  - **Output Directory**: `dist`

### Netlify

- **Build Command**: `yarn build`
- **Publish directory**: `dist`
- 또는 `netlify.toml`이 포함되어 있어서, repo 연결만 해도 자동 설정됩니다.

### 정적 호스팅(수동 업로드)

```bash
yarn build
```

생성된 `dist/` 폴더를 정적 호스팅에 업로드하면 됩니다.

## 참고

- 카메라는 보통 `localhost`에서 잘 동작합니다.
- 조명이 어둡거나 손이 너무 가까우면 인식이 불안정할 수 있어요(30~60cm 권장).
