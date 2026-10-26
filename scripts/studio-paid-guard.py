#!/usr/bin/env python3
"""PreToolUse hook for background Studio runs: no Higgsfield credits without the owner's approval.

Loaded only into runs the Studio starts (claude -p --settings …). Only known free Higgsfield tools
(uploads, balance, models, waiting on jobs, show_/get_/list_/search_ lookups) always pass. Every other
Higgsfield tool, including any new or unknown one and anything that posts or publishes, is allowed only
as a price check (get_cost: true on every job) or in a turn the Studio started from the owner's Approve
click (env STUDIO_PAID=1). Everything else is blocked (exit 2), and the message tells the model to post a
gate instead. Unreadable input is blocked too.
"""
import json, os, sys

FREE = {
    "balance", "transactions", "media_upload", "media_confirm", "media_import_url", "jobs_wait", "job_display",
    "models_explore", "apps_search", "apps_describe", "show_plans_and_credits", "show_credit_reset",
}
FREE_PREFIXES = ("show_", "get_", "list_", "search_")


def is_free(name):
    return name in FREE or (name.startswith(FREE_PREFIXES) and name not in PAID)


PAID = {
    "generate_video", "generate_video_batch", "generate_image", "generate_image_batch", "generate_audio",
    "generate_audio_batch", "generate_3d", "upscale_video", "upscale_image", "outpaint_image", "reframe",
    "remove_background", "execute_preset", "motion_control", "dubbing", "voice_change", "create_voice",
    "create_voice_from_confirmed_audio", "scene_builder_3d_generate_video", "scene_builder_3d_generate_angles",
    "ads_studio_generate", "ai_influencer_generate", "build_ai_influencer", "shorts_studio_create",
}


def as_obj(value):
    if isinstance(value, str) and value.lstrip()[:1] in "{[":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def is_price_check(value):
    """True only when every job in the call is a price check: get_cost: true at the top level (or in a
    "params"-style wrapper), and for batch calls on every job in the list. One flagged job in a batch
    of real jobs is not enough."""
    value = as_obj(value)
    if isinstance(value, list):
        jobs = [as_obj(v) for v in value]
        return bool(jobs) and all(is_price_check(j) for j in jobs)
    if not isinstance(value, dict):
        return False
    if value.get("get_cost") is True:
        return True
    # Without its own flag, a dict counts only as a pure wrapper ({"params": {...}} / {"jobs": [...]}):
    # any setting of its own (model, prompt…) makes it a real job.
    nested = [as_obj(v) for v in value.values()]
    if not nested or any(not isinstance(v, (dict, list)) for v in nested):
        return False
    return all(is_price_check(v) for v in nested)


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        print("Studio paid guard: unreadable hook input; blocking this call.", file=sys.stderr)
        return 2
    name = str(event.get("tool_name", "")).rsplit("__", 1)[-1]
    if is_free(name):
        return 0
    if is_price_check(event.get("tool_input", {})) or os.environ.get("STUDIO_PAID") == "1":
        return 0
    print(
        f"Blocked by the Studio: {name} spends Higgsfield credits and this run has no approval. "
        "Preflight with get_cost: true, post the price as a gate with scripts/studio-gate.sh "
        "(include the credits), then end your turn. The owner approves in the Studio, which resumes "
        "this run with paid tools enabled.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as err:  # never let a crash become "allowed"
        print(f"Studio paid guard error ({err}); blocking this call.", file=sys.stderr)
        sys.exit(2)
