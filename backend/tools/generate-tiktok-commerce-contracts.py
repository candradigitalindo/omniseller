#!/usr/bin/env python3
"""Generate static TikTok Shop commerce contracts from an independently captured public snapshot.

Usage (from backend/):
  python3 tools/generate-tiktok-commerce-contracts.py --snapshot /path/to/snapshot
  pnpm exec biome check --write packages/connectors/tiktokshop/src/commerce-contracts.ts packages/connectors/tiktokshop/src/commerce-contracts

The snapshot layout and read-only official documentation URLs are documented in
packages/connectors/tiktokshop/README.md. This tool reads JSON/Markdown as data only,
uses only Python's standard library, makes no network requests and executes no
snapshot code. It verifies the navigation checksum and refuses incomplete metadata.

Each documented default operation is retained. Unsupported transports, absent
scopes/schema, explicit other-market restrictions and existing owned mutations are
unavailable; no path, principal, scope or input field is invented. A schema-valid
operation still requires app approval and Indonesia/account program entitlement.
An applicable listed scope is a necessary preflight condition only. The marketplace
remains authoritative for sufficient API/app/program authorization; no scope
implications are inferred and ordinary packages never require Full Service access.

The fixed dedicated-mutation set was reviewed against the pre-commerce application
CSV at commit 834f22d; never regenerate that policy from the expanded current audit,
or every newly integrated operation would incorrectly become unavailable.
"""
import pathlib, json, re, collections, hashlib, argparse, urllib.parse
parser = argparse.ArgumentParser(description='Generate reviewed TikTok commerce descriptors from public documentation data only')
parser.add_argument('--snapshot', type=pathlib.Path, required=True)
parser.add_argument('--output-dir', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / 'packages/connectors/tiktokshop/src')
parser.add_argument('--data-output-dir', type=pathlib.Path)
args = parser.parse_args()
p = args.snapshot.resolve()
capture = json.loads((p / 'snapshot.json').read_text())
if capture.get('issues'):
    raise ValueError('Snapshot has unresolved documentation download failures')
if hashlib.sha256((p / 'tree.json').read_bytes()).hexdigest() != capture['tree_sha256']:
    raise ValueError('Navigation checksum mismatch')
tree = json.loads((p / 'tree.json').read_text())['data']['document_tree']
nodes = {x['document_id']: x for x in tree}
for node in tree:
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', node['document_id']):
        raise ValueError('Unsafe document identifier')
    if not node['is_dir'] and not (p / 'details' / (node['document_id'] + '.json')).exists():
        raise ValueError('Missing document detail: ' + node['document_id'])

def ancestry(i):
    a = []
    seen = set()
    while i in nodes:
        if i in seen:
            raise ValueError('Cyclic documentation ancestry')
        seen.add(i)
        a.insert(0, nodes[i]['name'])
        i = nodes[i]['parent_id']
    return a

def read(f):
    return json.loads(f.read_text()) if f.exists() else None
dedicated_mutations = {'POST /fulfillment/202309/packages/{id}/ship', 'POST /product/202309/images/upload', 'POST /product/202309/products', 'POST /product/202309/products/activate', 'POST /product/202309/products/deactivate', 'POST /product/202309/products/{id}/inventory/update', 'POST /product/202309/products/{id}/prices/update', 'POST /return_refund/202309/cancellations/{id}/approve', 'POST /return_refund/202309/cancellations/{id}/reject', 'POST /return_refund/202309/returns/{id}/approve', 'POST /return_refund/202602/cancellations', 'POST /return_refund/202606/returns/{id}/reject', 'PUT /event/202309/webhooks'}

def canonical(path):
    return re.sub('\\{[^}]+\\}', '{id}', path)
common = {'app_key', 'sign', 'timestamp', 'shop_cipher', 'category_asset_cipher', 'access_token', 'refresh_token', 'app_secret'}
# These exceptions were reviewed against the complete official document and SDK examples.
# Bind them to exact source bytes: a future documentation change requires another review.
reviewed_contracts = {
    '650a9191c16ffe02b8eec161': {
        'metadata': 'ae6284ae84bfa69c827502287a7e458db32c342b1bd3d2d25666a3b265ad5cb0',
        'document': '08583916029fe9cce0ba77e318313fea3d8b3880d7c97bbcc62e827949c144f0',
        'readOnly': True,
        'decision': 'Inventory Search explicitly retrieves inventory for product_ids/sku_ids. Its POST request contains only search identifiers, never quantities or updates.',
    },
    '69dde24cf76068049e2730b8': {
        'metadata': '51bda8d035e65db796a44a1659c8d4a674da9cc29f20459e86352c75bc277503',
        'document': 'd93158ebf86cb52295bae0bdba58c29bb8c31ce7afd7be96d6695eed9ca87341',
        'readOnly': True,
        'decision': 'List Opportunities explicitly searches and retrieves paginated leads using category, timestamp, type and tag filters; it does not create or change opportunities.',
    },
    '6a296867f76068049e634aa4': {
        'metadata': '977c1789335973cb0e9a968aeb0ce502e693d087534c13225175598cc2bb210b',
        'document': '3b83ddca540674ada38299685dc1c498de7fc401775b483b4896c368408848f6',
        'readOnly': True,
        'decision': 'List Product SKPP Statuses is explicitly a batch status query using product IDs, a status filter and pagination; no update is submitted.',
    },
    '67287d619ba2a002fe590322': {
        'metadata': '143953e859358624317242bf4f4ca8ab16dda1194f098f964dbd42871ca3dd9a',
        'document': 'c29c25fc822de836b03868df3781deef218e78464233ea8badb025440fdd9038',
        'readOnly': True,
        'decision': 'Creator Search Sample Application Fulfillments explicitly queries existing fulfillment statuses; its body is a status filter rather than a fulfillment command.',
    },
    '66716aa19a01ec02e5b90513': {
        'metadata': '6d7210413d296aec09946412969d225916f84b7f550a9fff95d34f81422dea20',
        'document': 'b934febe716093fa98eb31e0435335758c981c44965c1af6ef345067992306aa',
        'readOnly': True,
        'decision': 'Seller Search Open Collaboration Products explicitly searches eligible products using keyword/category/price/commission filters; no collaboration or product is changed.',
    },
    '6a335dc2f180ee049bf09ed6': {
        'metadata': '1adb2ad3cd8de4c71385e7a3b9ad014b826829f1bdcaa439d83a604f088e5185',
        'document': '7aa4cc29897d14dab977750213e8435061c9327e5deb67244fc2e37ca4695c4c',
        'decision': 'The GET JSON body is explicit in the request table and Go/Java/Node SDK examples; the dedicated transport preserves it. Tokopedia int64 identifiers use exact decimal-string input and numeric JSON wire values.',
    },
    '6791db764ddec3030b395150': {
        'metadata': 'bc8e0f12777bc63e796d0d4b0ca1af01749571aaf36a08ea78a0e87c2c3ff5af',
        'document': '0e841ce2574376a0e8813f766010f316c3ede0e841c2bc0e988eeba1806eed1c',
        'decision': 'only_need_conversation_id is explicitly documented and sampled as a query field; omit its redundant optional GET body copy.',
    },
    '68c8c9ed5514fb049cae029f': {
        'metadata': '64738a50a601142147c77e89f316a109690daf4124597f9860cccde9e215fed8',
        'document': '53acfe2edb7fdd85530f148fef74f1df336720af82e6402b1a3642c6ced28063',
        'decision': 'The official Path and query example explicitly name campaign_id and product_id placeholders. Require opaque strings without coercion; never substitute a different endpoint or infer a missing permission.',
    },
}
raw = []
catalog = []
errors = []

def fields(rows, prefix=''):
    roots = []
    stack = []
    issues = []
    for r in rows:
        name = r.get('name', '').strip()
        depth = len(name) - len(name.lstrip('^'))
        name = name.lstrip('^').strip()
        if not name or not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_-]*', name):
            issues.append('unrecognized_field_name:' + name)
            continue
        if depth == 0 and name in common:
            continue
        if re.search('only (?:available|applicable|supported) (?:in|for|to) (?:the )?(?:US|United States|UK|United Kingdom)(?: local seller)?(?:\\b|$)', r.get('desc', ''), re.I) and (not re.search('Indonesia|\\bID\\b', r.get('desc', ''), re.I)):
            continue
        t = r.get('type', '').strip()
        isarr = t.startswith('[]') or t.endswith('[]')
        base = t.removeprefix('[]').removesuffix('[]').strip()
        types = {'string': 'string', 'int': 'integer', 'int32': 'integer', 'float': 'number', 'double': 'number', 'number': 'number', 'bool': 'boolean', 'boolean': 'boolean', 'object': 'object', 'file': 'file'}
        if base not in types:
            issues.append('unsupported_type:' + base)
            base = 'string'
        typ = types[base]
        f = {'name': prefix + name if depth == 0 else name, 'label': name.replace('_', ' ').capitalize(), 'type': 'array' if isarr else typ, 'required': r.get('required', '').upper() in ['Y', 'TRUE'], 'description': r.get('desc', '')}
        if isarr:
            f['itemType'] = typ
        if typ == 'object':
            f['children'] = []
        if typ == 'integer' and (not isarr) and re.search('(?:Unix|epoch) timestamp', r.get('desc', ''), re.I):
            f['format'] = 'datetime'
            f['timestampUnit'] = 'milliseconds' if re.search('milliseconds|millisecond', r.get('desc', ''), re.I) else 'seconds'
        if typ == 'string' and (not isarr) and ('YYYY-MM-DD' in r.get('desc', '')):
            f['format'] = 'date'
        if typ in ['integer', 'number', 'string'] and (not isarr) and re.search('(?:^|_)(?:price|amount|fee|cost|budget)(?:$|_)', name) and (not re.search('percent|ratio|basis points|hundredths', r.get('desc', ''), re.I)):
            f['format'] = 'money'
        if re.search('Required (?:if|when) (?:the )?(?:target )?(?:market|region) (?:is|in|=) [^\\n.]*\\bID\\b', r.get('desc', ''), re.I):
            f['required'] = True
        desc = r.get('desc', '')
        if typ == 'string' and (not isarr) and re.search('enumerat|possible values|valid values|supported values', desc, re.I):
            # Horizontal whitespace only: \s can swallow the next enum bullet as a description.
            values = re.findall(r'''^[ \t]*[-*][ \t]*[`'"]?([A-Z][A-Z0-9_]*)[`'"]?(?:[ \t]*[:\-][^\r\n]*)?[ \t]*$''', desc, re.M)
            if len(values) > 1:
                f.update(type='enum', options=list(dict.fromkeys(values)))
        if depth:
            if depth > len(stack) or 'children' not in stack[depth - 1]:
                issues.append('malformed_nested_schema:' + name)
                continue
            stack[depth - 1]['children'].append(f)
        else:
            roots.append(f)
        stack = stack[:depth] + [f]
    for f in roots:

        def check(n):
            if n.get('type') == 'object' and (not n.get('children')):
                issues.append('object_schema_missing:' + n['name'])
            if n.get('type') == 'array' and n.get('itemType') == 'object' and (not n.get('children')):
                issues.append('array_item_schema_missing:' + n['name'])
            for c in n.get('children', []):
                check(c)
        check(f)
    return (roots, issues)
for node in tree:
    if node['is_dir'] or not node['is_api_doc'] or node['doc_type'] != 1:
        continue
    i = node['document_id']
    md = read(p / 'api-meta' / f'{i}.json')
    detail = read(p / 'details' / f'{i}.json') or {}
    m = (md or {}).get('document_api_meta', {})
    if not m:
        raise ValueError('Missing metadata for ' + i)
    reviewed = reviewed_contracts.get(i)
    if reviewed and (
        hashlib.sha256((p / 'api-meta' / f'{i}.json').read_bytes()).hexdigest() != reviewed['metadata']
        or hashlib.sha256((p / 'details' / f'{i}.json').read_bytes()).hexdigest() != reviewed['document']
    ):
        raise ValueError('Reviewed contract source changed; explicit re-review required: ' + i)
    group = ancestry(i)[1]
    content = detail.get('content', '')
    curl = next((x.get('value', '') for x in m.get('sample_code', []) if x.get('key') == 'curl'), '')
    method = re.search('^#\\s*Method:\\s*\\[?(GET|POST|PUT|PATCH|DELETE)', content, re.M) or re.search('\\bcurl\\s+-X\\s+(GET|POST|PUT|PATCH|DELETE)', curl)
    method = method.group(1) if method else None
    path = m.get('interface_path')
    documented_auth_types = {scope['auth_type'] for scope in m.get('scope_list', []) if scope.get('scope_key') and scope.get('auth_type') in [1, 2, 4]}
    principal_auth_type = next(iter(documented_auth_types)) if len(documented_auth_types) == 1 else 2 if group == 'Affiliate creator' else 4 if group == 'Affiliate partner' else 1
    scopes = [x['scope_key'] for x in m.get('scope_list', []) if x.get('scope_key') and x.get('auth_type') == principal_auth_type]
    header = ' '.join((x.get('desc', '') for x in m.get('request_header_param', []) if x.get('name', '').lower() == 'x-tts-access-token'))
    principal = {1: 'seller', 2: 'creator', 4: 'affiliate_partner'}[principal_auth_type]
    issues = []
    if not method:
        issues.append('HTTP method is not explicitly documented')
    if not path:
        issues.append('API path is not explicitly documented')
    elif not re.fullmatch(r'/[a-z_]+/\d{6}(?:/[A-Za-z0-9_{}.-]+)*', path) or '..' in path.split('/'):
        issues.append('API path requires dedicated protocol review')
    if not scopes:
        issues.append('API scope has not been documented')
    documented_user_types = {int(value) for value in re.findall(r'user_type\s*=\s*([0-9])\b', header)}
    if documented_user_types and {1: 0, 2: 1, 4: 3}[principal_auth_type] not in documented_user_types:
        issues.append('Principal metadata and access-token documentation disagree')
    if method == 'PATCH':
        issues.append('PATCH transport is pending')
    if len(documented_auth_types) > 1:
        issues.append('Shared-principal binary upload requires a dedicated file workflow')
    if group == 'Authorization':
        issues.append('Authorization and private assets use the dedicated connection workflow')
    if group in ['Authorization', 'Seller', 'Global product', 'Global fulfillment', 'Global seller', 'Global logistics'] and (not re.search('user_type\\s*=\\s*0\\b', header)):
        issues.append('Authorization or principal applicability requires a dedicated workflow')
    if re.search('user_type\\s*=\\s*[45]\\b', header) or group.startswith('Global ') or (path and re.search(r'/(?:global_[a-z_]+|global_replicate)(?:/|$)', path)):
        issues.append('Global selling account is outside the Indonesia seller/creator scope')
    contenttypes = [x.get('desc', '') for x in m.get('request_header_param', []) if x.get('name', '').lower() == 'content-type']
    if any(('multipart' in x.lower() or 'octet-stream' in x.lower() for x in contenttypes)):
        issues.append('Binary upload transport is pending')
    request = []
    if method == 'GET' and m.get('request_body_param'):
        issues.append('GET body requires a dedicated documented transport')
    if any((x.get('name', '').lstrip('^') in ['cipher', 'shop_cipher', 'category_asset_cipher', 'access_token', 'refresh_token', 'app_secret'] for x in m.get('request_body_param', []))):
        issues.append('Private request fields require a dedicated workflow')
    for key, prefix in [('request_path_param', 'path.'), ('request_query_param', 'query.'), ('request_body_param', 'body.')]:
        fs, es = fields(m.get(key, []), prefix)
        request += fs
        issues += es
    if reviewed and i == '6791db764ddec3030b395150':
        request = [field for field in request if field['name'] != 'body.only_need_conversation_id']
        issues = [issue for issue in issues if issue != 'GET body requires a dedicated documented transport']
    if reviewed and i == '6a335dc2f180ee049bf09ed6':
        for field in request:
            if field['name'] == 'body.toko_pids':
                field.update(itemType='string', required=True, minimum=1, maximum=100)
                field['description'] += ' Enter exact positive decimal IDs; the connector sends JSON int64 values without floating-point conversion. The application permits up to 100 IDs per lookup.'
        issues = [issue for issue in issues if issue != 'GET body requires a dedicated documented transport']
    if reviewed and i == '68c8c9ed5514fb049cae029f':
        for name in ['campaign_id', 'product_id']:
            request.append({'name': 'path.' + name, 'label': name.replace('_', ' ').capitalize(), 'type': 'string', 'required': True, 'maxLength': 200, 'description': 'Exact ' + name + ' placeholder from the official API Path. Preserve the identifier as text.'})
    if path == '/analytics/202609/shop_videos/batch_performance':
        for field in request:
            if field['name'] == 'query.video_ids':
                field['itemType'] = 'string'
                field['description'] += ' Preserve each numeric int64 video ID as an exact decimal string; numeric JSON is generated without floating-point conversion.'
    for name in re.findall('\\{([^}]+)\\}', path or ''):
        if not any((x['name'] == 'path.' + name for x in request)):
            issues.append('Path parameter schema missing:' + name)
    response, es = fields(m.get('response_param', []))
    resproots = [x for x in response if x['name'] == 'data']
    public = []
    if resproots:
        public = [x['name'] for x in resproots[0].get('children', []) if x['name'] not in ['cipher', 'category_asset_cipher', 'shop_cipher', 'access_token', 'refresh_token', 'authorization_code', 'code']]
    elif not any((x['name'] == 'code' for x in response)):
        issues.append('Response envelope schema is missing')
    envdesc = m.get('env_desc', '')
    functionDescription = re.search('^# Function Description\\n(.*?)(?=\\n#|\\n---|\\Z)', content, re.S)
    regiontext = envdesc + '\n' + (functionDescription.group(1) if functionDescription else '')
    regionexclusion = re.search('(?:only\\s+(?:available|supported|applicable)\\s+(?:in|for|to)|(?:available|supported)\\s+(?:only|exclusively)\\s+(?:in|for|to)|only\\s+available\\s+(?:in|for|to))\\s+([^\\n.]+)', regiontext, re.I)
    if regionexclusion and re.search('United States|United Kingdom|\\bUS\\b|\\bUK\\b|\\bGB\\b|Brazil|Japan|\\bBR\\b|\\bJP\\b|Europe|EU markets', regionexclusion.group(1), re.I) and (not re.search('Indonesia|\\bID\\b', regionexclusion.group(1), re.I)):
        issues.append('Documented region restriction requires review: ' + regionexclusion.group(0))
    read_only = method == 'GET' or bool(re.match('^(?:Search|Get(?! or Create)|Query|Check|Recommend|Calculate|Validate|Preview)\\b', node['name'], re.I)) or bool(reviewed and reviewed.get('readOnly'))
    if method in ['PUT', 'DELETE', 'PATCH']:
        read_only = False
    if not read_only and f'{method} {canonical(path or chr(0))}' in dedicated_mutations:
        issues.append('Use the existing dedicated application workflow')
    if group == 'Event' and not read_only:
        issues.append('Webhook subscriptions use the dedicated connection workflow')
    if not read_only and re.search('/products(?:/\\{[^}]+\\})?/(?:inventory|prices)(?:/|$)', path or ''):
        issues.append('Stock and regular price changes use the existing ledger and confirmation workflow')
    docpath = m.get('document_path') or node.get('document_path') or i
    operation = {'id': 'tiktok_' + i, 'channel': 'tiktokshop', 'principalKind': principal, 'title': node['name'], 'group': group, 'method': method or 'GET', 'path': path or '', 'scopes': scopes, 'scopeMode': 'any', 'write': not read_only, 'officialUrl': 'https://partner.tiktokshop.com/docv2/page/' + docpath, 'fields': request, 'available': not issues, 'unavailableReason': '; '.join(dict.fromkeys(issues)) if issues else None, 'responseFields': public, 'eligibility': 'unverified', 'eligibilityReason': 'An applicable listed scope is a necessary preflight condition, not proof of sufficient API access. Marketplace authorization, current app approval and Indonesia program entitlement remain authoritative.'}
    if group == 'Fulfilled by TikTok (FBT)' and path != '/fbt/202409/merchants/onboarded_regions' and ('seller.fbt.info' not in operation['scopes']):
        operation['scopes'].append('seller.fbt.info')
    if group == 'Fulfilled by TikTok (FBT)':
        operation['scopeMode'] = 'all'
    if any((x.get('name') == 'category_asset_cipher' for x in m.get('request_query_param', []))):
        operation['categoryAsset'] = True
    raw.append({'provenance': {'metadataSha256': hashlib.sha256((p / 'api-meta' / f'{i}.json').read_bytes()).hexdigest(), 'documentSha256': hashlib.sha256((p / 'details' / f'{i}.json').read_bytes()).hexdigest()}, 'operation': operation, 'catalogDocumentId': i, 'version': re.search('/([0-9]{6})/', path or '').group(1) if re.search('/([0-9]{6})/', path or '') else None, 'description': envdesc, 'requestSchema': {k: m.get(k, []) for k in ['request_header_param', 'request_path_param', 'request_query_param', 'request_body_param']}, 'responseSchema': m.get('response_param', []), 'scopePackages': [{k: x.get(k) for k in ['scope_key', 'package_name', 'package_type', 'auth_type', 'data_source_list']} for x in m.get('scope_list', [])], 'principalEvidence': header, 'marketEvidence': regionexclusion.group(0) if regionexclusion else None, 'schemaIssues': es})
    catalog.append(operation)
runtime_contracts = []
query_serializers = {}
for family in tree:
    if family['is_dir'] or not family['is_api_doc'] or family['doc_type'] != 1:
        continue
    versions = read(p / 'versions' / (family['document_id'] + '.json'))
    if versions is None:
        raise ValueError('Missing API version list: ' + family['document_id'])
    version_ids = [entry['external_doc_id'] for entry in versions.get('api_external_list', [])]
    if family['document_id'] not in version_ids:
        version_ids.append(family['document_id'])
    for document_id in dict.fromkeys(version_ids):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', document_id):
            raise ValueError('Unsafe version document identifier')
        detail = read(p / 'details' / (document_id + '.json'))
        metadata = read(p / 'api-meta' / (document_id + '.json'))
        if detail is None or metadata is None:
            raise ValueError('Missing API version metadata/detail: ' + document_id)
        meta = metadata['document_api_meta']
        curl = next((sample.get('value', '') for sample in meta.get('sample_code', []) if sample.get('key') == 'curl'), '')
        match = re.search(r'^#\s*Method:\s*\[?(GET|POST|PUT|PATCH|DELETE)', detail.get('content', ''), re.M) or re.search(r'\bcurl\s+-X\s+(GET|POST|PUT|PATCH|DELETE)', curl)
        if match is None or match.group(1) not in ['GET', 'POST', 'PUT', 'DELETE']:
            raise ValueError('Unverified API version HTTP method: ' + document_id)
        runtime_contracts.append({
            'method': match.group(1),
            'path': meta['interface_path'],
            'scopes': [{'name': scope['scope_key'], 'authType': scope['auth_type']} for scope in meta.get('scope_list', []) if scope.get('scope_key')],
            'officialUrl': 'https://partner.tiktokshop.com/docv2/page/' + (meta.get('document_path') or document_id),
        })
        sample_query = urllib.parse.parse_qs(urllib.parse.urlparse(meta.get('query', '')).query)
        for field in meta.get('request_query_param', []):
            if not field.get('type', '').startswith('[]'):
                continue
            example = sample_query.get(field['name'], [''])[0]
            if field['type'] == '[]string' and example and not example.startswith('['):
                encoding = 'csv'
            elif field['type'] == '[]int' and re.fullmatch(r'\[[0-9]+(?:,[0-9]+)*\]', example):
                encoding = 'json_int64'
            else:
                raise ValueError('Array query encoding is not proven by the official example: ' + document_id + ':' + field['name'])
            serializers = query_serializers.setdefault(meta['interface_path'], {})
            if field['name'] in serializers and serializers[field['name']] != encoding:
                raise ValueError('Conflicting query array encodings: ' + document_id)
            serializers[field['name']] = encoding
expected = sum((not node['is_dir'] and node['is_api_doc'] and (node['doc_type'] == 1) for node in tree))
if len(catalog) != expected:
    raise ValueError(f'Catalog is incomplete: {len(catalog)}/{expected}')
if len({op['id'] for op in catalog}) != len(catalog):
    raise ValueError('Duplicate catalog IDs')
for op in catalog:
    if op['available'] and (not op['scopes'] or not op['path'].startswith('/')):
        raise ValueError('Available operation lacks a verified contract: ' + op['id'])

def data_hash(directory):
    h = hashlib.sha256()
    for file in sorted((p / directory).glob('*.json')):
        h.update(file.name.encode())
        h.update(b'\x00')
        h.update(file.read_bytes())
        h.update(b'\x00')
    return h.hexdigest()
manifest = {'fetchedAt': capture['fetched_at'], 'treeSha256': capture['tree_sha256'], 'apiMetadataSha256': data_hash('api-meta'), 'documentDetailsSha256': data_hash('details'), 'versionListsSha256': data_hash('versions'), 'navigationEntries': len(tree), 'catalogOperations': len(catalog), 'apiVersionDocuments': len(list((p / 'api-meta').glob('*.json'))), 'availableContracts': sum((op['available'] for op in catalog)), 'reviewedContracts': {key: value for key, value in reviewed_contracts.items() if key in nodes}, 'scopeSemantics': 'An applicable listed package is a necessary condition only; marketplace authorization remains authoritative. FBT requires its additional documented onboarding preflight scope.', 'eligibility': 'App approval, Indonesia market/program and actual account grants remain runtime prerequisites.', 'dedicatedMutationPolicySource': 'AUDIT-TIKTOKSHOP-KODE.csv at repository commit 834f22d869ae0378bdc29e7c9a4aa7b6573944a1'}
output = args.output_dir.resolve()
target = output / 'commerce-contracts'
target.mkdir(parents=True, exist_ok=True)
imports = []
exports = []
for group, ops in sorted(collections.defaultdict(list, {group: [op for op in catalog if op['group'] == group] for group in {op['group'] for op in catalog}}).items()):
    slug = re.sub('[^a-z0-9]+', '-', group.lower()).strip('-')
    constant = slug.replace('-', '_').upper() + '_OPERATIONS'
    filename = target / (slug + '.ts')
    filename.write_text('import type { CommerceOperation } from "@omniseller/connector-core";\n\n/** Generated by tools/generate-tiktok-commerce-contracts.py; edit the generator, not this file. */\nexport const ' + constant + ': readonly CommerceOperation[] = ' + json.dumps(ops, ensure_ascii=False, indent=2) + ';\n')
    imports.append('import { ' + constant + ' } from "./commerce-contracts/' + slug + '.js";')
    exports.append('  ...' + constant + ',')
header = 'import type { CommerceOperation } from "@omniseller/connector-core";\n' + '\n'.join(imports) + '\n\n'
header += '/** Public documentation provenance; these counts are contract coverage, not live marketplace approval. */\n'
header += 'export const TIKTOK_COMMERCE_CONTRACT_CAPTURE = ' + json.dumps(manifest, ensure_ascii=False, indent=2) + ' as const;\n\n'
header += '/** Reviewed static method/path allowlist. Authorization and existing owned mutations use dedicated workflows. */\n'
header += 'export const TIKTOK_COMMERCE_OPERATIONS: readonly CommerceOperation[] = [\n' + '\n'.join(exports) + '\n];\n'
(output / 'commerce-contracts.ts').write_text(header)
runtime_header = """/** Generated from all published API versions by tools/generate-tiktok-commerce-contracts.py.
 * authType: 1 seller, 2 creator, 4 partner. Lists preserve metadata, not a claim of sufficient grants.
 */
export interface TiktokRuntimeScopeContract {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scopes: readonly { name: string; authType: number }[];
  officialUrl: string;
}
export const TIKTOK_RUNTIME_SCOPE_CONTRACTS: readonly TiktokRuntimeScopeContract[] = """
(output / 'runtime-scope-contracts.ts').write_text(runtime_header + json.dumps(runtime_contracts, ensure_ascii=False, indent=2) + ';\n')
(output / 'commerce-query-contracts.ts').write_text('''/** Generated from explicit array query examples in all official API versions.
 * Wire encoding is endpoint-specific; JSON arrays and comma-separated lists are not interchangeable.
 */
export const TIKTOK_COMMERCE_QUERY_SERIALIZERS: Readonly<Record<string, Readonly<Record<string, "csv" | "json_int64">>>> = ''' + json.dumps(query_serializers, ensure_ascii=False, indent=2) + ';\n')

# Only explicit reviewed failure containers affect mutation outcomes. Do not interpret unrelated
# monetary failed-delivery amounts or read-only listing/audit diagnostics as mutation refusals.
failure_names = {'errors', 'failed_items', 'failed_materials', 'failed_product_ids', 'failed_conversation_ids', 'failed_sku_ids', 'update_failed', 'target_collaboration_conflicts', 'error'}
failure_fields = {}
for operation in catalog:
    document_id = operation['id'].removeprefix('tiktok_')
    metadata = read(p / 'api-meta' / (document_id + '.json'))['document_api_meta']
    stack = []
    reviewed = []
    for field in metadata.get('response_param', []):
        raw_name = field.get('name', '')
        name = raw_name.lstrip('^')
        depth = len(raw_name) - len(name)
        stack = stack[:depth] + [name]
        if len(stack) > 1 and stack[0] == 'data' and name in failure_names:
            reviewed.append({'path': stack[1:], 'kind': 'code_object' if name == 'error' else 'failed_object' if name == 'update_failed' else 'failed_list'})
    if reviewed:
        failure_fields[operation['id']] = reviewed
failure_header = """/** Generated from reviewed official response_param fields by tools/generate-tiktok-commerce-contracts.py.
 * Only these failure containers affect mutations; read-only diagnostics remain successful reads.
 */
export interface TiktokFailureField {
  path: readonly string[];
  kind: "failed_list" | "failed_object" | "code_object";
}
export const TIKTOK_COMMERCE_FAILURE_FIELDS: Readonly<Record<string,readonly TiktokFailureField[]>> = """
(output / 'commerce-outcome-contracts.ts').write_text(failure_header + json.dumps(failure_fields, ensure_ascii=False, indent=2) + ';\n')

if args.data_output_dir:
    args.data_output_dir.mkdir(parents=True, exist_ok=True)
    for name, data in [('tiktokshop.operations.json', raw), ('tiktokshop.catalog.json', catalog), ('tiktokshop.provenance.json', manifest)]:
        (args.data_output_dir / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(manifest, ensure_ascii=False, indent=2))
print('Format generated files from backend/: pnpm exec biome check --write packages/connectors/tiktokshop/src/commerce-contracts.ts packages/connectors/tiktokshop/src/commerce-contracts packages/connectors/tiktokshop/src/runtime-scope-contracts.ts packages/connectors/tiktokshop/src/commerce-outcome-contracts.ts packages/connectors/tiktokshop/src/commerce-query-contracts.ts')
