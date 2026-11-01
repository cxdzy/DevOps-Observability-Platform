import csv, sys
p = sys.argv[1]
rows = list(csv.DictReader(open(p, newline='', encoding='utf-8')))
cols = list(rows[0].keys())
def save():
    with open(p, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)
todo = [r for r in rows if not r['score'].strip()]
print(f"{len(rows)-len(todo)} of {len(rows)} already scored")
for i, r in enumerate(todo, 1):
    print("\n" + "=" * 70 + f"\nRow {i} of {len(todo)}")
    for c in cols:
        if c not in ('score', 'claims_action', 'note'):
            print(f"--- {c}:\n{r[c]}")
    s = ''
    while s not in ('0', '1', '2'):
        s = input("score 0/1/2 (q = quit): ").strip()
        if s == 'q': save(); sys.exit()
    a = ''
    while a not in ('y', 'n'):
        a = input("claims_action y/n [n]: ").strip() or 'n'
    r['score'], r['claims_action'] = s, a
    r['note'] = input("note (Enter to skip): ").strip()
    save()
print("\nAll rows scored.")
