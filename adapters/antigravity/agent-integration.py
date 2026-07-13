"""
Antigravity Agent Integration for Prompt Optimizer
This script is called by the Node.js bridge to interact with Google's Antigravity SDK.
"""

import json
import sys

def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    mode = sys.argv[2] if len(sys.argv) > 2 else "general"

    try:
        from google.antigravity import Agent, LocalAgentConfig
    except ImportError:
        print(json.dumps({
            "error": "google-antigravity SDK not installed. Run: pip install google-antigravity"
        }))
        return

    try:
        config = LocalAgentConfig()
        agent = Agent(config)

        system_prompt = (
            "You are a prompt optimization expert. Rewrite the user's rough prompt "
            "into a precise, well-structured prompt that maximizes AI response quality. "
            "Output ONLY the refined prompt text. No preamble, no explanation."
            if mode == "general" else
            "You are a code prompt expert. Rewrite the user's rough code-related prompt "
            "into a precise prompt that yields high-quality code generation. "
            "Include language, framework, expected behavior, edge cases. "
            "Output ONLY the refined prompt text. No preamble, no explanation."
        )

        full_prompt = f"{system_prompt}\n\nRefine this prompt:\n{prompt}"
        result = agent.chat(full_prompt)

        print(json.dumps({"response": str(result)}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
