IMAGE ?= npm-bb
TAG ?= dev
NODE_MAJOR ?= 24
USER_ID ?= $(shell id -u)
GROUP_ID ?= $(shell id -g)
PROJECT_DIR := $(shell pwd)
WORKDIR ?= /home/developer
DOCKER_RUN_ARGS ?=

BUILD_ARGS = \
	--build-arg USER_ID=$(USER_ID) \
	--build-arg GROUP_ID=$(GROUP_ID) \
	--build-arg NODE_MAJOR=$(NODE_MAJOR)

RUN_ARGS = \
	--rm \
	-it \
	-v "$(PROJECT_DIR):$(WORKDIR)" \
	-w "$(WORKDIR)" \
	$(DOCKER_RUN_ARGS)

.PHONY: build run shell

build:
	docker build $(BUILD_ARGS) -t $(IMAGE):$(TAG) .

run: build
	docker run $(RUN_ARGS) $(IMAGE):$(TAG)

shell: run
