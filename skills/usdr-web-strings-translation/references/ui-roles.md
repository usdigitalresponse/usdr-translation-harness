# UI roles

Short interface strings are ambiguous on their own. "Apply" can mean submit an application, apply a filter, or apply a discount. Before translating, decide each string's **role** from where it appears. Use the template's markup, the developer's `Translators:` comment, the `msgctxt`, and the code around it. `po_tool.py scan` gives a first guess (`role_guess`) and the line it came from; confirm it by reading the page.

| Role | How to recognize it | Word form (defaults; see settings) | Length |
|---|---|---|---|
| **Button** | `<button>`, `type="submit"`, `class="button"` links | Infinitive: "Guardar", "Enviar solicitud" | Tight. Flag Spanish more than about twice the English; offer a shorter option. |
| **Navigation / menu item / tab** | Inside `<nav>`, menus, tab lists | Infinitive or noun: "Solicitar beneficios", "Mis solicitudes" | Tight |
| **Link (standalone)** | `<a>` on its own | Infinitive or noun: "Descargar su informe" | Moderate |
| **Link or call to action in a sentence** | Part of body text | Usted imperative: "Inicie sesión para continuar" | Not limited |
| **Heading / page title** | `<h1>`–`<h3>`, `<title>` | Sentence case. Imperative is fine for instructions ("Renueve sus beneficios"). | Moderate |
| **Form label** | `<label>`, a form field's `label=` | Noun phrase, no colon unless the English has one | Moderate |
| **Placeholder text** (in a field) | `placeholder=` | Example or short hint | Tight |
| **Help text** | `help_text=`, text under a field | Full sentences, usted | Not limited |
| **Error / validation message** | `ValidationError`, form errors | Say what to do: "Escriba un número entre 1 y 20." | Moderate |
| **Status message** | `messages.success(...)`, toasts | Short sentence | Moderate |
| **Email subject / body** | email templates, `send_mail` | Letter conventions ("Hola:" with a colon) | Subject is tight |
| **Accessibility label** | `aria-label`, alt text | Read aloud: natural, complete | Not shown |
| **Dropdown option** | `<option>` | Matches the label's grammar | Tight |

## Things to watch

- **Same English, different roles.** "Report" can be a noun (a document, "Informe") or a verb ("Informar un cambio"). If two different meanings share one `msgid` with no `msgctxt`, one translation can't serve both. Translate for the most common use, flag it, and suggest the developer add `pgettext`.
- **What's in the placeholder.** `%(first_name)s` could be anyone, so avoid gendered words around it. `%(count)s` affects plural agreement. For `%s` with no name, read the code to see what goes in it.
- **Words split across strings.** "Total: " plus an amount, or a sentence built from pieces: translate so the pieces still join correctly, and suggest the developer use one string with placeholders instead.
- **Length.** Short strings grow most in Spanish: often two to three times for strings of about 10 characters, versus about 1.3 times for long text ([W3C](https://www.w3.org/International/articles/article-text-size)). Forms and body text reflow; buttons, tabs and menus may not.
