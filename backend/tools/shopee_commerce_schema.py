"""Compile reviewed Shopee request row paths without guessing lost HTML nesting.

The crawler flattens parameter tables. Reviews pin the original request rows and
source digest; a changed doc must be reviewed again before it can add wire keys.
"""
from copy import deepcopy
import hashlib
import json
import re


def request_digest(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def reviewed_schema(rows, review, field_factory, method):
    if request_digest(rows) != review["requestRowsSha256"]:
        raise ValueError("Reviewed request rows changed; review the pinned contract again.")
    paths = review["rowPaths"]
    if len(paths) != len(rows):
        raise ValueError("Every request row must have a reviewed path or explicit omission.")
    omitted = review.get("omittedRows", {})
    root = "query" if method == "GET" else "body"
    fields = []
    by_path = {}
    numeric = []
    patches = review.get("fieldOverrides", {})
    for index, (row, path) in enumerate(zip(rows, paths)):
        if path is None:
            if not omitted.get(str(index)):
                raise ValueError("Omitted request row has no reviewed reason.")
            continue
        if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?)*", path):
            raise ValueError("Invalid reviewed request path.")
        parent, _, key = path.rpartition(".")
        key = key.removesuffix("[]")
        if key != row[0]:
            raise ValueError("Reviewed path must retain the documented wire field name.")
        wire_path = root + "." + path
        canonical = wire_path.removesuffix("[]")
        if canonical in by_path:
            raise ValueError("Duplicate reviewed wire path.")
        f = field_factory(row, (root + "." + key) if not parent else key)
        patch = patches.get(path, {})
        if set(patch) - {"type", "itemType", "required", "allowEmpty", "format", "timestampUnit", "options", "minimum", "maximum", "maxLength"}:
            raise ValueError("Unsupported reviewed field override.")
        f.update(deepcopy(patch))
        if bool(path.endswith("[]")) != (f["type"] == "array"):
            raise ValueError("Reviewed path array marker disagrees with field type.")
        if parent:
            parent_field = by_path.get(root + "." + parent.removesuffix("[]"))
            if parent_field is None or parent_field["type"] not in ("array", "object"):
                raise ValueError("Reviewed parent must be an earlier documented container.")
            if parent.endswith("[]") != (parent_field["type"] == "array"):
                raise ValueError("Reviewed parent array marker disagrees with field type.")
            parent_field.setdefault("children", []).append(f)
        else:
            fields.append(f)
        by_path[canonical] = f
        base = row[1].removesuffix("[]")
        if base in ("int", "int32", "int64") and (f["type"] == "string" or f.get("itemType") == "string"):
            numeric.append(wire_path)
    for path, f in by_path.items():
        if (f["type"] == "object" or (f["type"] == "array" and f.get("itemType") == "object")) and not f.get("children"):
            # An explicitly documented empty object is allowed; arbitrary keys remain disallowed.
            if path.removeprefix(root + ".") not in review.get("emptyObjects", []):
                raise ValueError("Reviewed container has no verified child fields.")
            f["children"] = []
    unused = set(patches) - {p for p in paths if p is not None}
    if unused:
        raise ValueError("Reviewed override has no request row.")
    return fields, numeric


def compile_field(row,name=None,labels=None):
 key,typ,req,sample,desc=(row+['']*5)[:5];base=typ.removesuffix('[]');array=typ.endswith('[]')
 f={'name':name or key,'label':(labels or {}).get(key,key.replace('_',' ').capitalize()),'type':'string','required':req.lower()=='true','description':desc[:2000]}
 if key=='cursor' and base=='string' and ('Default is \"\"' in desc or sample=='\"\"'):f['allowEmpty']=True
 if base in ['int','int32','int64']:
  # Int64 IDs remain strings, including lists, until their exact numeric serialization at transport.
  isid=bool(re.search(r'(?:^|_)(?:id|ids)$',key)) or key.endswith('_id_list') or (base=='int64' and not re.search(r'time|offset|limit|page|count|quantity|stock|size|index|amount|weight|duration|point',key))
  f['type']='string' if isid else 'integer'
 elif base in ['timestamp']:f['type']='integer';f['format']='datetime';f['timestampUnit']='seconds'
 elif base=='float':f['type']='number'
 elif base=='boolean':f['type']='boolean'
 elif base=='object':f['type']='object'
 elif base!='string':raise ValueError('unsupported request type '+base)
 if base=='string' and re.fullmatch(r'\d{4}-\d{2}-\d{2}',sample):f['format']='date'
 if base=='string' and re.fullmatch(r'\d{2}:\d{2}',sample):f['format']='time'
 if f['type']=='integer' and re.search(r'(?:^|_)(?:time|time_from|time_to|created_at|updated_at)$',key) and re.fullmatch(r'1[0-9]{9}',sample):f['format']='datetime';f['timestampUnit']='seconds'
 if f['type']=='number' and re.search(r'(?:price|amount|budget|fee|discount_value)$',key):f['format']='money'
 if f.get('format')=='datetime' and 'millisecond' in desc.lower():f['timestampUnit']='milliseconds'
 if array:f['itemType']=f['type'];f['type']='array'
 return f
