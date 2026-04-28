/**
 * Render a prompt template by substituting `{name}` placeholders.
 *
 *   renderPrompt("Hello {name}, you are {age}", { name: "Milou", age: 5 })
 *   // → "Hello Milou, you are 5"
 *
 * Variables can be strings, numbers, or booleans. Anything else is
 * coerced via String(). Missing variables are an error in strict mode
 * (default) — surfaces typos before they reach the model.
 *
 * Designed for the prompt-library pattern: each project keeps its
 * own prompt templates (in Supabase, in code, wherever) and uses
 * this to fill in user input at request time.
 */

export type PromptVars = Record<string, string | number | boolean | null | undefined>;

export type RenderPromptOpts = {
  /** If true (default), missing variables throw. If false, missing
   *  `{name}` placeholders are left in the output as-is. */
  strict?: boolean;
};

export function renderPrompt(
  template: string,
  vars: PromptVars,
  opts: RenderPromptOpts = {},
): string {
  const strict = opts.strict ?? true;
  const missing: string[] = [];

  const result = template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in vars) {
      const v = vars[key];
      if (v == null) {
        if (strict) missing.push(key);
        return match;
      }
      return String(v);
    }
    if (strict) missing.push(key);
    return match;
  });

  if (strict && missing.length > 0) {
    const unique = Array.from(new Set(missing));
    throw new Error(
      `renderPrompt: missing variables: ${unique.join(", ")}`,
    );
  }

  return result;
}
