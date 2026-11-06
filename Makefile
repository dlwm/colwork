SOURCE ?= local
NPM_VERSION ?= 0.2.0

.PHONY: dev build-site
dev:
	COLWORK_NPM_VERSION=$(NPM_VERSION) npm run dev -- --source=$(SOURCE)

build-site:
	COLWORK_NPM_VERSION=$(NPM_VERSION) npm run build:site -- --source=$(SOURCE)
