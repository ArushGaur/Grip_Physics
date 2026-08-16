#!/usr/bin/env python3
"""
LaTeX → OMML (Office Math Markup Language) post-processor for DOCX files.
Usage: python3 latex_to_omml.py input.docx output.docx [template.docx]

FIXES:
 - Merge all w:r text within a paragraph first, then convert $...$ → OMML
 - This handles the case where docx library splits a single text run
   into multiple <w:r> elements, breaking $math$ detection.
 - Properly embeds images from questionImage field.
"""
import sys, zipfile, re, io, os, html

# ─── Pre-processor: normalize bare math text to proper LaTeX ─────────────────

# Ordered list of (pattern, replacement) applied to raw $ content before parsing.
# Handles common cases where equations are typed without proper LaTeX backslashes.
_BARE_FUNC_RE = re.compile(
    r'(?<![\\a-zA-Z])'          # not preceded by \ or letter (avoid double-converting)
    r'(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|exp|lim|max|min|det|mod|gcd)'
    r'(?![a-zA-Z])'             # not followed by letter
)

def _normalize_latex(expr):
    """
    Normalize informal/bare math notation to proper LaTeX before parsing.
    Examples:
      tan^-1(x)    → \\tan^{-1}(x)
      tan^{-1}(x)  → \\tan^{-1}(x)   (backslash already handled by tokenizer)
      10^5         → 10^{5}
      2*pi         → 2\\pi
      2pi          → 2\\pi
    """
    s = expr

    # 1. Add backslash to bare function names (sin, cos, tan, etc.)
    s = _BARE_FUNC_RE.sub(r'\\\1', s)

    # 2. Normalize bare ^ exponents: x^-1 → x^{-1}, x^2 → x^{2}
    #    (only if not already braced)
    def brace_exponent(m):
        base = m.group(1)
        exp  = m.group(2)
        if exp.startswith('{'):
            return base + exp          # already braced
        # single char or negative number → brace it
        return base + '{' + exp + '}'
    s = re.sub(r'(\^)([-]?\d+(?:\.\d+)?|[a-zA-Z])', brace_exponent, s)

    # 3. bare "pi" not preceded by \ → \pi
    s = re.sub(r'(?<!\\)\bpi\b', r'\\pi', s)

    # 4. bare "omega" → \omega, "alpha" → \alpha, etc.
    for word, cmd in [('omega','omega'),('alpha','alpha'),('beta','beta'),
                      ('gamma','gamma'),('delta','delta'),('theta','theta'),
                      ('lambda','lambda'),('mu','mu'),('sigma','sigma'),
                      ('phi','phi'),('epsilon','epsilon')]:
        s = re.sub(r'(?<!\\)\b' + word + r'\b', r'\\' + cmd, s)

    # 5. * used as multiplication dot → \cdot (only between operands, not inside words)
    s = re.sub(r'(?<=[\w\)\}])\*(?=[\w\(\{])', r'\\cdot ', s)

    return s

# ─── LaTeX tokenizer ────────────────────────────────────────────────────────

def tokenize(s):
    tokens = []
    i = 0
    while i < len(s):
        if s[i] == '\\':
            j = i + 1
            if j < len(s) and s[j].isalpha():
                while j < len(s) and s[j].isalpha():
                    j += 1
                tokens.append(('CMD', s[i:j]))
            else:
                ch = s[j] if j < len(s) else ''
                tokens.append(('CHAR', ch))
                j = i + 2
            i = j
        elif s[i] in '{}^_':
            tokens.append(('SYM', s[i]))
            i += 1
        elif s[i].isspace():
            i += 1
        else:
            if s[i].isdigit() or (s[i] == '-' and i+1 < len(s) and s[i+1].isdigit()):
                j = i
                if s[j] == '-': j += 1
                while j < len(s) and (s[j].isdigit() or s[j] == '.'):
                    j += 1
                tokens.append(('NUM', s[i:j]))
                i = j
            else:
                tokens.append(('CHAR', s[i]))
                i += 1
    return tokens

def parse_group(tokens, pos):
    if pos >= len(tokens):
        return ('run', ''), pos
    if tokens[pos] == ('SYM', '{'):
        pos += 1
        items = []
        while pos < len(tokens) and tokens[pos] != ('SYM', '}'):
            item, pos = parse_single(tokens, pos)
            items.append(item)
        if pos < len(tokens): pos += 1
        if len(items) == 0: return ('run', ''), pos
        if len(items) == 1: return items[0], pos
        return ('seq', items), pos
    else:
        return parse_single(tokens, pos)

GREEK = {
    '\\alpha':'α','\\beta':'β','\\gamma':'γ','\\Gamma':'Γ',
    '\\delta':'δ','\\Delta':'Δ','\\epsilon':'ε','\\varepsilon':'ε',
    '\\zeta':'ζ','\\eta':'η','\\theta':'θ','\\vartheta':'θ','\\Theta':'Θ',
    '\\iota':'ι','\\kappa':'κ','\\lambda':'λ','\\Lambda':'Λ',
    '\\mu':'μ','\\nu':'ν','\\xi':'ξ','\\Xi':'Ξ',
    '\\pi':'π','\\Pi':'Π','\\rho':'ρ','\\varrho':'ρ',
    '\\sigma':'σ','\\Sigma':'Σ','\\tau':'τ',
    '\\upsilon':'υ','\\phi':'φ','\\varphi':'φ','\\Phi':'Φ',
    '\\chi':'χ','\\psi':'ψ','\\Psi':'Ψ','\\omega':'ω','\\Omega':'Ω',
}
SYMBOLS = {
    '\\pm':'±','\\mp':'∓','\\times':'×','\\cdot':'·','\\div':'÷',
    '\\leq':'≤','\\le':'≤','\\geq':'≥','\\ge':'≥','\\neq':'≠','\\ne':'≠',
    '\\approx':'≈','\\equiv':'≡','\\infty':'∞','\\partial':'∂','\\nabla':'∇',
    '\\rightarrow':'→','\\to':'→','\\leftarrow':'←',
    '\\Rightarrow':'⇒','\\Leftarrow':'⇐','\\leftrightarrow':'↔',
    '\\hbar':'ℏ','\\propto':'∝','\\sim':'∼','\\simeq':'≃',
    '\\forall':'∀','\\exists':'∃','\\in':'∈','\\notin':'∉',
    '\\subset':'⊂','\\supset':'⊃','\\cup':'∪','\\cap':'∩',
    '\\degree':'°','\\circ':'∘','\\cdots':'⋯','\\ldots':'…',
    '\\perp':'⊥','\\parallel':'∥','\\angle':'∠',
    '\\Omega':'Ω','\\omega':'ω',
}
FUNCS = {'\\sin','\\cos','\\tan','\\cot','\\sec','\\csc',
         '\\sinh','\\cosh','\\tanh','\\log','\\ln','\\exp',
         '\\lim','\\max','\\min','\\det','\\mod','\\gcd'}
SKIP_CMDS = {'\\left','\\right','\\big','\\Big','\\bigg','\\Bigg',
              '\\quad','\\qquad','\\!','\\,','\\;','\\:',
              '\\displaystyle','\\textstyle','\\scriptstyle',
              '\\normalsize','\\small','\\large'}
BRACKET_MAP = {'(':'(', ')':')', '[':'[', ']':']', '|':'|',
               '.':'', '\\langle':'⟨','\\rangle':'⟩',
               '\\{':'{','\\}':'}','\\|':'‖'}

def parse_single(tokens, pos):
    if pos >= len(tokens):
        return ('run', ''), pos
    tok = tokens[pos]
    pos += 1

    if tok[0] == 'CMD':
        cmd = tok[1]
        if cmd == '\\frac':
            num, pos = parse_group(tokens, pos)
            den, pos = parse_group(tokens, pos)
            node = ('frac', num, den)
        elif cmd in ('\\dfrac','\\tfrac','\\cfrac'):
            num, pos = parse_group(tokens, pos)
            den, pos = parse_group(tokens, pos)
            node = ('frac', num, den)
        elif cmd == '\\sqrt':
            deg = None
            if pos < len(tokens) and tokens[pos] == ('CHAR', '['):
                pos += 1
                deg_items = []
                while pos < len(tokens) and tokens[pos] != ('CHAR', ']'):
                    it, pos = parse_single(tokens, pos)
                    deg_items.append(it)
                if pos < len(tokens): pos += 1
                deg = ('seq', deg_items) if len(deg_items) > 1 else (deg_items[0] if deg_items else ('run',''))
            arg, pos = parse_group(tokens, pos)
            node = ('sqrt', arg, deg)
        elif cmd in FUNCS:
            node = ('func', cmd[1:])
        elif cmd in GREEK:
            node = ('run', GREEK[cmd])
        elif cmd in SYMBOLS:
            node = ('run', SYMBOLS[cmd])
        elif cmd in SKIP_CMDS:
            if cmd in ('\\left','\\right') and pos < len(tokens):
                bchar = tokens[pos][1]
                pos += 1
                mapped = BRACKET_MAP.get(bchar, bchar)
                node = ('run', mapped) if mapped else ('run', '')
            else:
                node = ('run', ' ' if 'quad' in cmd or cmd in ('\\,','\\;','\\:') else '')
        elif cmd in ('\\vec','\\overrightarrow'):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '⃗', arg)
        elif cmd in ('\\hat','\\widehat'):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '^', arg)
        elif cmd in ('\\bar','\\overline'):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '‾', arg)
        elif cmd in ('\\dot',):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '˙', arg)
        elif cmd in ('\\ddot',):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '¨', arg)
        elif cmd in ('\\tilde','\\widetilde'):
            arg, pos = parse_group(tokens, pos)
            node = ('acc', '~', arg)
        elif cmd in ('\\text','\\mathrm','\\mathbf','\\mathit',
                     '\\mathcal','\\mathbb','\\boldsymbol','\\mbox'):
            arg, pos = parse_group(tokens, pos)
            node = ('upright', arg)
        elif cmd in ('\\not',):
            arg, pos = parse_single(tokens, pos)
            node = ('run', '̸' + flatten(arg))
        elif cmd in ('\\sum',):
            node = ('run', '∑')
        elif cmd in ('\\prod',):
            node = ('run', '∏')
        elif cmd in ('\\int',):
            node = ('run', '∫')
        elif cmd in ('\\oint',):
            node = ('run', '∮')
        else:
            node = ('run', cmd[1:] if len(cmd) > 1 else cmd)
    elif tok[0] == 'NUM':
        node = ('num', tok[1])
    elif tok[0] == 'CHAR':
        node = ('run', tok[1])
    else:
        node = ('run', '')

    # superscript / subscript
    while pos < len(tokens) and tokens[pos] in [('SYM','^'), ('SYM','_')]:
        kind = tokens[pos][1]
        pos += 1
        exp, pos = parse_group(tokens, pos)
        if kind == '^':
            if node[0] == 'sub':
                node = ('subsup', node[1], node[2], exp)
            else:
                node = ('sup', node, exp)
        else:
            if node[0] == 'sup':
                node = ('subsup', node[1], exp, node[2])
            else:
                node = ('sub', node, exp)

    return node, pos

def parse_expr(tokens, pos=0):
    items = []
    while pos < len(tokens) and tokens[pos] not in [('SYM','}')]:
        item, pos = parse_single(tokens, pos)
        items.append(item)
    if not items: return ('run', ''), pos
    if len(items) == 1: return items[0], pos
    return ('seq', items), pos

def esc(s):
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def flatten(node):
    if node[0] in ('run','num','sym','func','upright'):
        return str(node[1]) if isinstance(node[1], str) else flatten(node[1])
    elif node[0] == 'seq':
        return ''.join(flatten(n) for n in node[1])
    return ''

def render(node):
    t = node[0]
    if t == 'run':
        return f'<m:r><m:t xml:space="preserve">{esc(node[1])}</m:t></m:r>' if node[1] else ''
    elif t == 'num':
        return f'<m:r><m:rPr><m:nor/></m:rPr><m:t>{esc(node[1])}</m:t></m:r>'
    elif t == 'func':
        return f'<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve">{esc(node[1])}</m:t></m:r>'
    elif t == 'upright':
        txt = flatten(node[1])
        return f'<m:r><m:rPr><m:nor/></m:rPr><m:t>{esc(txt)}</m:t></m:r>'
    elif t == 'sym':
        return f'<m:r><m:t>{esc(node[1])}</m:t></m:r>'
    elif t == 'seq':
        return ''.join(render(n) for n in node[1])
    elif t == 'frac':
        return f'<m:f><m:num>{render(node[1])}</m:num><m:den>{render(node[2])}</m:den></m:f>'
    elif t == 'sqrt':
        deg_xml = render(node[2]) if node[2] else ''
        hide = ' m:val="1"' if not node[2] else ''
        return f'<m:rad><m:radPr><m:degHide{hide}/></m:radPr><m:deg>{deg_xml}</m:deg><m:e>{render(node[1])}</m:e></m:rad>'
    elif t == 'sup':
        return f'<m:sSup><m:e>{render(node[1])}</m:e><m:sup>{render(node[2])}</m:sup></m:sSup>'
    elif t == 'sub':
        return f'<m:sSub><m:e>{render(node[1])}</m:e><m:sub>{render(node[2])}</m:sub></m:sSub>'
    elif t == 'subsup':
        return (f'<m:sSubSup><m:e>{render(node[1])}</m:e>'
                f'<m:sub>{render(node[2])}</m:sub>'
                f'<m:sup>{render(node[3])}</m:sup></m:sSubSup>')
    elif t == 'acc':
        return (f'<m:acc><m:accPr><m:chr m:val="{esc(node[1])}"/></m:accPr>'
                f'<m:e>{render(node[2])}</m:e></m:acc>')
    return ''

def latex_to_omml_xml(latex):
    """Convert LaTeX expression to OMML XML content (inside oMath)."""
    normalized = _normalize_latex(latex.strip())
    tokens = tokenize(normalized)
    tree, _ = parse_expr(tokens)
    return render(tree)

NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

def wrap_omml(inner_xml):
    return f'<m:oMath {NS}>{inner_xml}</m:oMath>'

def _html_unescape_all(s):
    """Repeatedly unescape HTML entities until stable (handles double-encoding)."""
    if not isinstance(s, str):
        s = str(s)
    prev = None
    cur = s
    while cur != prev:
        prev = cur
        cur = html.unescape(cur)
    return cur


# ─── DOCX post-processor ─────────────────────────────────────────────────────

def extract_text_from_run(run_xml):
    """Extract plain text from a single <w:r> element."""
    texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', run_xml, re.DOTALL)
    return ''.join(texts)

def extract_rpr_from_run(run_xml):
    """Extract <w:rPr>...</w:rPr> from a run element."""
    m = re.search(r'<w:rPr>(.*?)</w:rPr>', run_xml, re.DOTALL)
    return m.group(0) if m else ''

def split_math(text):
    """Split text into [(is_math, content)] pairs on $...$ and $$...$$."""
    parts = []
    i = 0
    while i < len(text):
        if text[i:i+2] == '$$':
            end = text.find('$$', i+2)
            if end != -1:
                parts.append((True, text[i+2:end]))
                i = end + 2
                continue
        if text[i] == '$':
            end = text.find('$', i+1)
            if end != -1 and end > i+1:
                parts.append((True, text[i+1:end]))
                i = end + 1
                continue
        j = i
        while j < len(text) and text[j] != '$':
            j += 1
        if j > i:
            parts.append((False, text[i:j]))
        i = j
    return parts if parts else [(False, text)]

def esc(s):
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def process_paragraph(para_xml):
    """
    Process a single <w:p>...</w:p> element:
    1. Collect all runs and their text
    2. Merge adjacent text runs that together form $...$ math
    3. Replace math segments with OMML
    """
    # If no math markers at all, skip quickly
    if '$' not in para_xml:
        return para_xml

    # Extract all runs from the paragraph (preserve non-run content like bookmarks)
    # We'll process runs in sequence
    
    # Strategy: find all <w:r> blocks, collect text, rebuild paragraph
    # We need to preserve the paragraph properties and non-run elements.
    
    # Split paragraph into: pPr block + sequence of runs/other elements
    ppr_match = re.search(r'<w:pPr>.*?</w:pPr>', para_xml, re.DOTALL)
    ppr = ppr_match.group(0) if ppr_match else ''
    
    # Get everything between <w:p...> opening and </w:p>
    p_open = re.match(r'<w:p\b[^>]*>', para_xml)
    p_open_tag = p_open.group(0) if p_open else '<w:p>'
    
    # Collect all child elements in order
    # We'll tokenize the paragraph content at the top level
    inner = para_xml[len(p_open_tag):-len('</w:p>')]
    
    # Split into runs and non-run elements
    # Find all <w:r>...</w:r> with their positions
    runs = list(re.finditer(r'<w:r\b[^>]*>.*?</w:r>', inner, re.DOTALL))
    
    if not runs:
        return para_xml
    
    # Check if any run contains a $ (possibly as part of a cross-run math span)
    # Concatenate all run texts to check for math
    all_text = ''.join(extract_text_from_run(r.group(0)) for r in runs)
    if '$' not in all_text:
        return para_xml
    
    # Merge all run texts into a single string, remembering boundaries
    # We also keep the rPr from the FIRST run that has one
    first_rpr = ''
    run_texts = []
    for r in runs:
        t = extract_text_from_run(r.group(0))
        run_texts.append(t)
        if not first_rpr:
            first_rpr = extract_rpr_from_run(r.group(0))
    
    merged_text = ''.join(run_texts)
    
    # Split on math markers
    parts = split_math(merged_text)
    
    # Build replacement XML for the runs section
    new_runs_xml = ''
    has_math = any(is_math for is_math, _ in parts)
    
    if not has_math:
        return para_xml
    
    for is_math, content in parts:
        if not content:
            continue
        if is_math:
            # HTML-unescape math content too (e.g. k&apos; inside $...$)
            math_src = _html_unescape_all(content)
            inner_omml = latex_to_omml_xml(math_src)
            new_runs_xml += wrap_omml(inner_omml)
        else:
            space_attr = ' xml:space="preserve"' if (content.startswith(' ') or content.endswith(' ')) else ''
            # HTML-unescape any entities (e.g. &apos;) that may have been introduced
            # earlier in the pipeline, then escape for XML output.
            txt = _html_unescape_all(content)
            new_runs_xml += f'<w:r>{first_rpr}<w:t{space_attr}>{esc(txt)}</w:t></w:r>'
    
    # Now rebuild the paragraph:
    # Replace the span of all runs with our new content
    # We keep everything before first run and after last run
    first_run_start = runs[0].start()
    last_run_end = runs[-1].end()
    
    new_inner = inner[:first_run_start] + new_runs_xml + inner[last_run_end:]
    return p_open_tag + new_inner + '</w:p>'


def process_docx_xml(doc_xml):
    """
    Process the full document.xml:
    - For each paragraph, merge all run texts and convert $...$ to OMML.
    """
    # Process each paragraph individually
    def replace_para(m):
        return process_paragraph(m.group(0))
    
    result = re.sub(r'<w:p\b[^>]*>.*?</w:p>', replace_para, doc_xml, flags=re.DOTALL)
    return result


def merge_with_template(gen_entries, tpl_entries):
    """
    Merge template headers/footers/styles/media into the generated doc.

    Strategy:
    1. Copy styles, settings, fonts, theme from template.
    2. Copy ALL template header/footer XML files and ALL media files verbatim.
    3. Copy ALL template header/footer/image relationships into the generated
       document.xml.rels, remapping IDs only where they clash with existing ones.
    4. Copy header/footer _rels files from template (for any per-header images).
    5. Replace the generated doc's sectPr with the template's sectPr wholesale —
       this brings in page size, margins, borders, and header/footer references
       all at once with the correct original rId values, avoiding any ID mismatch.
    6. Patch Content_Types.xml so Word can find every part.
    """

    # ── 1. Static parts ──────────────────────────────────────────────────────
    for name in ['word/styles.xml', 'word/settings.xml', 'word/fontTable.xml',
                 'word/theme/theme1.xml', 'word/theme/theme2.xml',
                 'word/webSettings.xml']:
        if name in tpl_entries:
            gen_entries[name] = tpl_entries[name]

    # ── 2. Copy header/footer XML files and ALL media from template ───────────
    for name, data in tpl_entries.items():
        if (name.startswith('word/header') or name.startswith('word/footer')
                or name.startswith('word/media/')):
            gen_entries[name] = data

    # ── 3. Merge document.xml.rels ────────────────────────────────────────────
    rels_key = 'word/_rels/document.xml.rels'
    if rels_key in tpl_entries and rels_key in gen_entries:
        tpl_rels_xml = tpl_entries[rels_key].decode('utf-8', errors='replace')
        gen_rels_xml = gen_entries[rels_key].decode('utf-8', errors='replace')

        # Collect all rId numbers already used in the generated doc
        gen_used_ids = set(int(x) for x in re.findall(r'Id="rId(\d+)"', gen_rels_xml))
        next_free = max(gen_used_ids, default=0) + 1

        # Parse template relationships — keep header, footer, image entries
        KEEP_TYPES = ('header', 'footer', 'image', 'Image', 'Header', 'Footer')
        tpl_rels = re.findall(r'<Relationship\b[^>]*/>', tpl_rels_xml)

        id_remap = {}   # old tpl rId → new rId (only when there's a clash)
        new_rel_tags = []

        for rel_tag in tpl_rels:
            typ_m = re.search(r'Type="([^"]+)"', rel_tag)
            rid_m = re.search(r'Id="([^"]+)"', rel_tag)
            if not typ_m or not rid_m:
                continue
            if not any(k in typ_m.group(1) for k in KEEP_TYPES):
                continue

            old_id  = rid_m.group(1)
            # Check if this rId is already taken in gen_rels
            num_m = re.match(r'rId(\d+)$', old_id)
            if num_m and int(num_m.group(1)) in gen_used_ids:
                # Clash — assign a fresh ID
                new_id = f'rId{next_free}'
                next_free += 1
                id_remap[old_id] = new_id
                rel_tag = rel_tag.replace(f'Id="{old_id}"', f'Id="{new_id}"')
            else:
                # No clash — keep the original ID (avoids unnecessary remapping)
                if num_m:
                    gen_used_ids.add(int(num_m.group(1)))

            new_rel_tags.append(rel_tag)

        if new_rel_tags:
            insert = '\n' + '\n'.join(new_rel_tags) + '\n'
            gen_rels_xml = gen_rels_xml.replace('</Relationships>',
                                                 insert + '</Relationships>')
            gen_entries[rels_key] = gen_rels_xml.encode('utf-8')

        # If any IDs were remapped, patch the header/footer XML files too
        if id_remap:
            for name in list(gen_entries.keys()):
                if name.startswith('word/header') or name.startswith('word/footer'):
                    try:
                        xml = gen_entries[name].decode('utf-8', errors='replace')
                        for old, new in id_remap.items():
                            xml = xml.replace(f'r:id="{old}"', f'r:id="{new}"')
                            xml = xml.replace(f'r:embed="{old}"', f'r:embed="{new}"')
                        gen_entries[name] = xml.encode('utf-8')
                    except Exception:
                        pass

    # ── 4. Copy per-header/footer _rels files from template ──────────────────
    for name, data in tpl_entries.items():
        if re.match(r'word/_rels/(header|footer)\d*\.xml\.rels$', name):
            gen_entries[name] = data

    # ── 5. Replace sectPr in generated document.xml with template's sectPr ───
    #    This is the safest approach: the template sectPr already has the correct
    #    rId values for its header/footer references, page size, margins, borders.
    if 'word/document.xml' in tpl_entries and 'word/document.xml' in gen_entries:
        tpl_doc = tpl_entries['word/document.xml'].decode('utf-8', errors='replace')
        gen_doc = gen_entries['word/document.xml'].decode('utf-8', errors='replace')

        tpl_secpr_m = re.search(r'<w:sectPr\b.*?</w:sectPr>', tpl_doc, re.DOTALL)
        if tpl_secpr_m:
            tpl_secpr = tpl_secpr_m.group(0)

            # If any IDs were remapped, patch the sectPr headerReference rIds too
            if id_remap:
                for old, new in id_remap.items():
                    tpl_secpr = tpl_secpr.replace(f'r:id="{old}"', f'r:id="{new}"')

            # Replace (or append) sectPr in the generated doc
            if re.search(r'<w:sectPr\b', gen_doc):
                gen_doc = re.sub(r'<w:sectPr\b.*?</w:sectPr>', tpl_secpr,
                                 gen_doc, count=1, flags=re.DOTALL)
            else:
                # No sectPr — insert before </w:body>
                gen_doc = gen_doc.replace('</w:body>', tpl_secpr + '\n</w:body>', 1)

            gen_entries['word/document.xml'] = gen_doc.encode('utf-8')

    # ── 5b. Inject template body header paragraphs at the top of generated body ─
    # The Triumph template has its branding (PHYSICS, logo, NAME OF STUDENT line)
    # in the BODY (not in Word headers/footers). We extract all paragraphs from
    # the template body (before sectPr) and prepend them to the generated document
    # body, replacing the generated title/date block.
    if 'word/document.xml' in tpl_entries and 'word/document.xml' in gen_entries:
        tpl_doc = tpl_entries['word/document.xml'].decode('utf-8', errors='replace')
        gen_doc = gen_entries['word/document.xml'].decode('utf-8', errors='replace')

        # Extract all <w:p> and <w:tbl> elements from template body (excluding sectPr)
        body_m = re.search(r'<w:body>(.*?)</w:body>', tpl_doc, re.DOTALL)
        if body_m:
            tpl_body_content = body_m.group(1)
            # Remove sectPr from template body content
            tpl_body_no_secpr = re.sub(r'<w:sectPr\b.*?</w:sectPr>', '', tpl_body_content, flags=re.DOTALL).strip()
            # Only inject if the template has meaningful content (non-empty paragraphs)
            # Check if there's actual text content beyond empty paragraphs
            has_real_content = bool(re.search(r'<w:t[^>]*>[^<]+</w:t>', tpl_body_no_secpr))
            if has_real_content and tpl_body_no_secpr:
                # Remove the generated title + date paragraphs (first 2 <w:p> blocks)
                # These are the auto-generated title and date line we want to replace
                gen_body_m = re.search(r'<w:body>(.*?)</w:body>', gen_doc, re.DOTALL)
                if gen_body_m:
                    gen_body_content = gen_body_m.group(1)
                    # Skip first 2 <w:p> elements (the generated title + date)
                    paras = list(re.finditer(r'<w:p\b', gen_body_content))
                    if len(paras) >= 2:
                        skip_end = paras[2].start() if len(paras) >= 3 else len(gen_body_content)
                        # For answer key mode, keep the "Answer Key" heading para too → skip 3
                        # We detect by checking if "Answer Key" text is in first 3 paras
                        first3_text = gen_body_content[:skip_end + 300]
                        if 'Answer Key' in first3_text and len(paras) >= 3:
                            skip_end = paras[3].start() if len(paras) >= 4 else len(gen_body_content)
                        gen_body_rest = gen_body_content[skip_end:]
                    else:
                        gen_body_rest = gen_body_content

                    # Patch any remapped rIds in the injected template body XML
                    # (e.g. rId5 logo image may have been remapped to rId8 to avoid clash)
                    if id_remap:
                        for old_id, new_id in id_remap.items():
                            tpl_body_no_secpr = tpl_body_no_secpr.replace(
                                f'r:embed="{old_id}"', f'r:embed="{new_id}"')
                            tpl_body_no_secpr = tpl_body_no_secpr.replace(
                                f'r:id="{old_id}"', f'r:id="{new_id}"')

                    # Rebuild body: template header + remaining generated content
                    new_body = tpl_body_no_secpr + '\n' + gen_body_rest
                    gen_doc = gen_doc.replace(gen_body_m.group(0),
                                              '<w:body>' + new_body + '</w:body>', 1)
                    gen_entries['word/document.xml'] = gen_doc.encode('utf-8')

    # ── 6. Patch Content_Types.xml ────────────────────────────────────────────
    ct_key = '[Content_Types].xml'
    if ct_key in tpl_entries and ct_key in gen_entries:
        tpl_ct = tpl_entries[ct_key].decode('utf-8', errors='replace')
        gen_ct = gen_entries[ct_key].decode('utf-8', errors='replace')

        # Already-registered PartNames in generated doc
        gen_parts = set(re.findall(r'PartName="([^"]+)"', gen_ct))
        # Already-registered Extensions
        gen_exts  = set(re.findall(r'Extension="([^"]+)"', gen_ct))

        new_items = []

        # Add Override entries (headers/footers) missing from gen
        for ov in re.finditer(r'<Override\b[^>]*/>', tpl_ct):
            pn_m = re.search(r'PartName="([^"]+)"', ov.group(0))
            if pn_m and pn_m.group(1) not in gen_parts:
                new_items.append(ov.group(0))
                gen_parts.add(pn_m.group(1))

        # Add Default entries (e.g. jpeg, png) missing from gen
        for dv in re.finditer(r'<Default\b[^>]*/>', tpl_ct):
            ext_m = re.search(r'Extension="([^"]+)"', dv.group(0))
            if ext_m and ext_m.group(1) not in gen_exts:
                new_items.append(dv.group(0))
                gen_exts.add(ext_m.group(1))

        if new_items:
            gen_ct = gen_ct.replace('</Types>', '\n'.join(new_items) + '\n</Types>')
            gen_entries[ct_key] = gen_ct.encode('utf-8')

    return gen_entries


def main():
    if len(sys.argv) < 3:
        print("Usage: latex_to_omml.py input.docx output.docx [template.docx]")
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2]
    tpl_path = sys.argv[3] if len(sys.argv) > 3 else None

    with zipfile.ZipFile(in_path, 'r') as z:
        gen_entries = {n: z.read(n) for n in z.namelist()}

    # Process document.xml — convert math
    if 'word/document.xml' in gen_entries:
        doc_xml = gen_entries['word/document.xml'].decode('utf-8', errors='replace')
        doc_xml = process_docx_xml(doc_xml)
        gen_entries['word/document.xml'] = doc_xml.encode('utf-8')

    # Add math namespace to document.xml if not present
    doc_xml = gen_entries['word/document.xml'].decode('utf-8', errors='replace')
    if 'm:oMath' in doc_xml and 'xmlns:m=' not in doc_xml:
        doc_xml = doc_xml.replace(
            '<w:document ',
            '<w:document xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ',
            1
        )
        gen_entries['word/document.xml'] = doc_xml.encode('utf-8')

    # Merge with template if provided
    if tpl_path and os.path.exists(tpl_path):
        with zipfile.ZipFile(tpl_path, 'r') as z:
            tpl_entries = {n: z.read(n) for n in z.namelist()}
        gen_entries = merge_with_template(gen_entries, tpl_entries)

    # Write output
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
        for name, data in gen_entries.items():
            zout.writestr(name, data)

    print('OK')

if __name__ == '__main__':
    main()
