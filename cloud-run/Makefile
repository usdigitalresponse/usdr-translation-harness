# Run any Cloud Run function locally using Google Functions Framework.
# JS functions: npm start in the function dir
# Python functions: functions-framework CLI pointing at the function

.PHONY: check install install-js install-py extract translate capture-feedback eval-quality eval-drift test test-js test-py

# ── Smoke test ───────────────────────────────────────────────────────
check:
	@echo "=== Environment Check ==="
	@echo ""
	@echo "Node.js:"
	@node --version 2>/dev/null && echo "  OK" || echo "  MISSING — install Node 18+ (brew install node)"
	@echo ""
	@echo "Python:"
	@python3 --version 2>/dev/null && echo "  OK" || echo "  MISSING — install Python 3.10+ (brew install python@3.11)"
	@echo ""
	@echo "Python venv:"
	@if [ -n "$$VIRTUAL_ENV" ]; then echo "  OK ($$VIRTUAL_ENV)"; else echo "  NOT ACTIVE — run: source .venv/bin/activate"; fi
	@echo ""
	@echo ".env file:"
	@if [ -f ../".env" ]; then echo "  OK"; else echo "  MISSING — run: cp .env.example .env"; fi
	@echo ""
	@echo "API keys:"
	@if [ -f ../".env" ]; then \
		. ../".env" 2>/dev/null; \
		if [ -n "$$ANTHROPIC_API_KEY" ]; then echo "  ANTHROPIC_API_KEY: set"; else echo "  ANTHROPIC_API_KEY: NOT SET"; fi; \
		if [ -n "$$GEMINI_API_KEY" ]; then echo "  GEMINI_API_KEY: set"; else echo "  GEMINI_API_KEY: NOT SET"; fi; \
	else \
		echo "  (skipped — no .env file)"; \
	fi
	@echo ""
	@echo "JS dependencies:"
	@if [ -d translate/node_modules ] && [ -d capture-feedback/node_modules ]; then echo "  OK"; else echo "  MISSING — run: make install-js"; fi
	@echo ""
	@echo "Python dependencies:"
	@python3 -c "import anthropic, google.genai, sacrebleu, rouge_score, functions_framework, pdfplumber" 2>/dev/null \
		&& echo "  OK" || echo "  MISSING — run: make install-py (with venv active)"
	@echo ""
	@echo "Config fixture:"
	@if [ -f extract/fixtures/config.json ]; then echo "  OK"; else echo "  MISSING — extract/fixtures/config.json not found"; fi
	@echo ""
	@echo "Extract function (required to run extract locally):"
	@if [ -f ../".env" ]; then \
		. ../".env" 2>/dev/null; \
		if [ -n "$$ANTHROPIC_API_KEY" ] || [ -n "$$GEMINI_API_KEY" ]; then echo "  API key: set"; else echo "  API key: NOT SET — need ANTHROPIC_API_KEY or GEMINI_API_KEY"; fi; \
		if [ -n "$$EXTRACTION_PROMPT_DOC_ID" ]; then echo "  EXTRACTION_PROMPT_DOC_ID: set"; else echo "  EXTRACTION_PROMPT_DOC_ID: NOT SET"; fi; \
		if [ -n "$$LOCAL_PDF_PATH" ]; then \
			if [ -f "$$LOCAL_PDF_PATH" ]; then echo "  LOCAL_PDF_PATH: set (file exists)"; \
			else echo "  LOCAL_PDF_PATH: set but FILE NOT FOUND — check the path"; fi; \
		else echo "  LOCAL_PDF_PATH: NOT SET — needed to run extract locally"; fi; \
	else \
		echo "  (skipped — no .env file)"; \
	fi
	@echo ""
	@echo "Doc IDs (other functions):"
	@if [ -f ../".env" ]; then \
		. ../".env" 2>/dev/null; \
		if [ -n "$$TRANSLATION_PROMPT_DOC_ID" ]; then echo "  TRANSLATION_PROMPT_DOC_ID: set"; else echo "  TRANSLATION_PROMPT_DOC_ID: not set"; fi; \
		if [ -n "$$EVALUATION_RUBRIC_DOC_ID" ]; then echo "  EVALUATION_RUBRIC_DOC_ID: set"; else echo "  EVALUATION_RUBRIC_DOC_ID: not set"; fi; \
		if [ -n "$$GLOSSARY_SHEET_ID" ]; then echo "  GLOSSARY_SHEET_ID: set"; else echo "  GLOSSARY_SHEET_ID: not set"; fi; \
		if [ -n "$$GOLDEN_SET_SHEET_ID" ]; then echo "  GOLDEN_SET_SHEET_ID: set"; else echo "  GOLDEN_SET_SHEET_ID: not set"; fi; \
	else \
		echo "  (skipped — no .env file)"; \
	fi
	@echo ""
	@echo "=== Done ==="

# ── Install ──────────────────────────────────────────────────────────
install: install-js install-py

install-js:
	cd translate && npm install
	cd capture-feedback && npm install
	npm install

install-py:
	pip install -r requirements-dev.txt
	pip install -r extract/requirements.txt

# ── Run locally ──────────────────────────────────────────────────────
extract:
	cd extract && functions-framework --target=extract --port=8081

translate:
	cd translate && npx functions-framework --target=translate --port=8082

capture-feedback:
	cd capture-feedback && npx functions-framework --target=captureFeedback --port=8083

eval-quality:
	cd eval/quality && functions-framework --target=eval_quality --port=8084

eval-drift:
	cd eval/drift && functions-framework --target=eval_drift --port=8085

# ── Test ─────────────────────────────────────────────────────────────
test: test-js test-py

test-js:
	npx jest --config jest.config.js

test-py:
	pytest
