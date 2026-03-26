# 로컬 LLM 환경 정리 (MAKi-LLM-Machine)

이 문서는 프로젝트에서 사용하는 **llama.cpp 기반 로컬 추론** 구성과, 기록 시점의 **호스트 사양**을 정리합니다. 다른 머신·서버에 옮길 때는 경로와 GPU 백엔드만 맞추면 됩니다.

**기록일:** 2026-03-26

---

## 1. 역할 구분

| 구분 | 설명 |
|------|------|
| **로컬 (개발 머신)** | macOS Apple Silicon, Metal로 GGUF 추론, 모델 파일은 `~/models` |
| **서버 (배포 시)** | Linux + NVIDIA(CUDA) 또는 동일 아키텍처에 맞는 llama.cpp 빌드, 경로만 조정 |

---

## 2. 기록 시점 하드웨어·OS (참고용)

아래 값은 **한 대의 Mac**에서 수집한 예시입니다. `sysctl`, `system_profiler`로 다시 확인하세요.

| 항목 | 값 (예시) |
|------|-----------|
| 모델 식별 | `Mac17,6` (Apple Silicon) |
| CPU 코어 | 18 (`hw.ncpu` / `hw.physicalcpu`) |
| 메모리 | 약 36 GiB (`hw.memsize` ≈ 38 654 705 664 bytes) |
| GPU | Apple GPU (Metal), 통합 메모리 |
| OS | macOS 26.x / Darwin 25.x, `arm64` |

**참고:** Apple Silicon에서는 시스템 RAM과 GPU가 통합 메모리를 공유합니다. 큰 컨텍스트(예: 65536)는 KV 캐시로 수 GB~수십 GB를 쓸 수 있어, OOM이 나면 `--ctx-size`를 낮춥니다.

---

## 3. 소프트웨어 스택

| 구성 요소 | 역할 | 비고 |
|-----------|------|------|
| [Homebrew](https://brew.sh/) | `git`, `cmake`, `wget` | macOS 패키지 관리 |
| [llama.cpp](https://github.com/ggerganov/llama.cpp) | GGUF 추론 | **CMake 빌드** (루트 `Makefile`은 안내용 에러만 출력) |
| Metal | macOS GPU 백엔드 | 빌드 시 macOS에서 기본 활성화 (`docs/build.md`) |

### 3.1 빌드 산출물 (기본 경로)

| 경로 | 설명 |
|------|------|
| `~/llama.cpp/build/bin/llama-completion` | **배치/원샷** 추론 (`-p` 프롬프트). 채팅 템플릿 모델은 **`-no-cnv`** 권장 |
| `~/llama.cpp/build/bin/llama-cli` | 대화형 TUI (채팅 템플릿 사용 시 기본 대화 모드) |
| `~/llama.cpp/build/bin/llama-server` | OpenAI 호환 HTTP 서버 (별도 용도) |

구버전의 `main` 실행 파일 이름은 현재 **`llama-completion`** 으로 통합된 흐름을 쓰는 것이 맞습니다.

### 3.2 일괄 설치 스크립트

저장소 루트의 **`setup-local-llm.sh`** 한 번에 다음을 수행합니다.

1. `brew install git cmake wget`
2. `~/llama.cpp` 클론 및 CMake Release 빌드
3. `~/models` 생성 및 GGUF 다운로드 (기본 URL, `wget -c`로 이어받기)
4. `run_deepseek_test.sh`, `run_qwen_test.sh` 생성
5. `~/.zshrc`에 `deepseek-run` / `qwen-run` 함수 추가 (이미 있으면 생략)

환경 변수:

- `SKIP_DOWNLOAD=1` — 모델 다운로드 생략  
- `SKIP_ZSHRC=1` — `.zshrc` 수정 생략  
- `FORCE_LLAMA_REBUILD=1` — llama.cpp 강제 재빌드  
- `LLAMA_CPP_ROOT`, `MODELS_DIR`, `DEEPSEEK_URL`, `QWEN_URL` — 경로·URL 재정의  

---

## 4. GGUF 모델 인벤토리 (기본)

| 파일 | Hugging Face 소스 (요약) | 용도 |
|------|--------------------------|------|
| `~/models/deepseek.gguf` | `bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF` → `DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf` | 코드·분석·지시 따르기 |
| `~/models/qwen.gguf` | `bartowski/Qwen2.5-7B-Instruct-GGUF` → `Qwen2.5-7B-Instruct-Q4_K_M.gguf` | 범용 지시·정리 (학습 컨텍스트 32k — 65k 지정 시 경고만 나올 수 있음) |

다른 양자화/모델로 바꿀 때는 같은 경로에 덮어쓰거나, 스크립트의 `MODEL` 환경 변수를 지정합니다.

---

## 5. 셸 헬퍼 (`~/.zshrc`)

설치 스크립트가 추가하는 **함수** (이미 등록되어 있으면 중복 추가 안 함):

- `deepseek-run …` — `llama-completion` + `deepseek.gguf`, `--ctx-size 32768`, `--temp 0.6`, `-no-cnv`  
- `qwen-run …` — 동일 바이너리 + `qwen.gguf`, `--ctx-size 65536`, `--temp 0.7`, `-no-cnv`  

예:

```bash
deepseek-run -p "한 문장으로 요약해줘: ..."
qwen-run -p "구조적으로 정리해줘: ..."
```

---

## 6. 검증 스크립트

| 스크립트 | 동작 |
|----------|------|
| `./run_deepseek_test.sh` | 컨텍스트 65536→49152→32768→16384 순으로 재시도 후 성공 시 종료 |
| `./run_qwen_test.sh` | 고정 프롬프트로 단일 추론 테스트 |

---

## 7. 서버(Linux 등) 배포 시 체크리스트

로컬과 동일한 **모델 파일**과 **llama.cpp 빌드**만 맞추면 됩니다. 차이는 GPU 백엔드입니다.

| 항목 | 권장 |
|------|------|
| 빌드 | [공식 build.md](https://github.com/ggerganov/llama.cpp/blob/master/docs/build.md) 에서 **CUDA / Vulkan** 등 타깃에 맞게 CMake 옵션 |
| 바이너리 경로 | 서버에서는 `/opt/llama.cpp/build/bin/llama-completion` 처럼 고정하고, 스크립트의 `LLAMA_COMPLETION`으로 지정 |
| 메모리 | VRAM·RAM이 부족하면 `-ngl`(GPU 레이어 수), `--ctx-size`, 양자화(Q4→Q3 등) 조정 |
| 무인 실행 | `llama-server` + API 클라이언트, 또는 `llama-completion` + `-no-cnv`로 배치 스크립트 |
| 재현성 | `llama.cpp` git 커밋 해시, CMake 캐시, 모델 파일 SHA를 문서화 |

---

## 8. 부가 도구 (선택)

| 도구 | 설명 |
|------|------|
| **llmfit** | `brew install llmfit` — 로컬 하드웨어에 맞는 모델 추천·점검 ([llmfit](https://github.com/AlexsJones/llmfit)) |

이 프로젝트의 필수 구성 요소는 아니며, 모델 선정 참고용입니다.

---

## 9. 빠른 참조

```text
프로젝트 루트:   setup-local-llm.sh
문서:           docs/local-llm-environment.md
llama.cpp:      ~/llama.cpp/build/bin/
모델:           ~/models/*.gguf
```

문제가 나면 `llama-completion` 실행에 **`-no-cnv`** 가 빠졌는지(채팅 템플릿 모델), **컨텍스트·메모리** 한계인지 순서로 확인하면 됩니다.
