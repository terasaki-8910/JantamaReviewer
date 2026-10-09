# Convenience entry points. Real logic is scripts/run.sh (POSIX).
.DEFAULT_GOAL := all
.PHONY: intake criteria design plan build accept integrate all auto status
# `auto` = unattended: intake stays a conversation, every stage after it runs with no prompts.
intake criteria design plan build accept integrate all auto status:
	@sh scripts/run.sh $@
