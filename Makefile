IMAGE ?= npm-bb
TAG ?= dev
NODE_MAJOR ?= 24
USER_ID ?= $(shell id -u)
GROUP_ID ?= $(shell id -g)
PROJECT_DIR := $(shell pwd)
WORKDIR ?= /home/developer
DOCKER_STYLE_RANDOM_NAME := $(shell \
	left='admiring adoring affectionate agitated amazing awesome blissful bold brave clever cool dreamy eager ecstatic elegant epic focused friendly gifted goofy gracious happy hopeful hungry inspiring jolly kind laughing loving lucid magical modest mystifying nifty optimistic peaceful practical quirky relaxed reverent silly sleepy stoic trusting vibrant vigilant wizardly wonderful youthful zealous'; \
	right='agnesi albattani allen archimedes banach bell benz borg bose boyd carson chandrasekhar curie darwin edison einstein euclid feynman galileo goldberg hawking heisenberg hopper hypatia jackson johnson khayyam liskov lovelace mclean mendeleev newton noether pasteur perlman pike poincare ritchey shannon tesla torvalds turing varahamihira volhard wright yonath'; \
	awk -v seed="$$(od -An -N4 -tu4 /dev/urandom)" -v left="$$left" -v right="$$right" 'BEGIN { srand(seed); left_count = split(left, l, " "); right_count = split(right, r, " "); print l[int(rand() * left_count) + 1] "-" r[int(rand() * right_count) + 1] }')
PREFIX ?= homes
PROJECT_SUBDIR ?= $(PROJECT_DIR)/$(PREFIX)/$(DOCKER_STYLE_RANDOM_NAME)
DOCKER_RUN_ARGS ?=

BUILD_ARGS = \
	--build-arg USER_ID=$(USER_ID) \
	--build-arg GROUP_ID=$(GROUP_ID) \
	--build-arg NODE_MAJOR=$(NODE_MAJOR)

RUN_ARGS = \
	--rm \
	-it \
    -h $(DOCKER_STYLE_RANDOM_NAME) \
	-v "$(PROJECT_SUBDIR):$(WORKDIR)" \
	-w "$(WORKDIR)" \
	$(DOCKER_RUN_ARGS)

.PHONY: build run shell

build:
	docker build $(BUILD_ARGS) -t $(IMAGE):$(TAG) .

run: build
	mkdir -p $(PROJECT_SUBDIR)
	docker run $(RUN_ARGS) $(IMAGE):$(TAG)

shell: run
