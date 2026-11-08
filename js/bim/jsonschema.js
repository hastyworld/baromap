// 작은 JSON Schema 검사기(외부 라이브러리 없이 브라우저·워커·Node·Edge Function 공용).
// AI 구조화 출력에 쓰는 것과 같은 스키마 객체로 결과를 다시 검사한다.
// 지원: type(배열·null 포함), properties, required, additionalProperties, items, enum, const, anyOf,
//       minimum, maximum, minItems, maxItems, minLength, maxLength, $ref('#/$defs/이름')

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeOk(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function check(schema, value, { root = schema, path = '$', errors = [], max = 30 } = {}) {
  if (errors.length >= max || !schema || schema === true) return errors;
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    return check((root.$defs || root.definitions || {})[name], value, { root, path, errors, max });
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => check(s, value, { root, path, errors: [], max }).length === 0);
    if (!ok) errors.push(`${path}: 허용된 모양이 아닙니다`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) { errors.push(`${path}: ${types.join('|')} 이어야 합니다(지금 ${typeOf(value)})`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: 허용되지 않은 값 ${JSON.stringify(value)}`);
  if ('const' in schema && schema.const !== value) errors.push(`${path}: ${JSON.stringify(schema.const)} 이어야 합니다`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: ${schema.minimum} 이상이어야 합니다`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: ${schema.maximum} 이하여야 합니다`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: 너무 짧습니다`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: 너무 깁니다`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: ${schema.minItems}개 이상이어야 합니다`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: ${schema.maxItems}개 이하여야 합니다`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, { root, path: `${path}[${i}]`, errors, max }));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: 빠졌습니다`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) check(props[k], v, { root, path: `${path}.${k}`, errors, max });
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: 정의에 없는 항목입니다`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, v, { root, path: `${path}.${k}`, errors, max });
    }
  }
  return errors;
}

export function assertValid(schema, value, label = '데이터') {
  const errors = check(schema, value);
  if (errors.length) {
    const err = new Error(`${label} 모양이 올바르지 않습니다: ${errors.slice(0, 5).join('; ')}`);
    err.errors = errors;
    throw err;
  }
  return value;
}

// 짧게 쓰는 도우미
export const S = {
  str: (o = {}) => ({ type: 'string', ...o }),
  num: (o = {}) => ({ type: 'number', ...o }),
  int: (o = {}) => ({ type: 'integer', ...o }),
  bool: () => ({ type: 'boolean' }),
  nul: (s) => ({ ...s, type: [].concat(s.type, 'null'), ...(s.enum ? { enum: [...s.enum, null] } : {}) }),
  arr: (items, o = {}) => ({ type: 'array', items, ...o }),
  obj: (properties, o = {}) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...o }),
  enm: (values) => ({ type: 'string', enum: values }),
};
