import { LaunchdServiceConfig, LaunchdServiceConfigSchema } from './launchd-types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderValue(value: unknown, indentLevel = 1): string {
  const indent = '    '.repeat(indentLevel);
  const childIndent = '    '.repeat(indentLevel + 1);

  if (typeof value === 'boolean') {
    return `${indent}<${value ? 'true' : 'false'}/>`;
  }

  if (typeof value === 'number') {
    return `${indent}<integer>${value}</integer>`;
  }

  if (typeof value === 'string') {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}<array/>`;
    }
    const items = value.map((item) => renderValue(item, indentLevel + 1)).join('\n');
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return `${indent}<dict/>`;
    }
    const lines: string[] = [];
    for (const [k, v] of entries) {
      if (v === undefined) continue;
      lines.push(`${childIndent}<key>${escapeXml(k)}</key>`);
      lines.push(renderValue(v, indentLevel + 1));
    }
    return `${indent}<dict>\n${lines.join('\n')}\n${indent}</dict>`;
  }

  return `${indent}<string>${escapeXml(String(value))}</string>`;
}

export function generateLaunchdPlist(rawConfig: LaunchdServiceConfig): string {
  const config = LaunchdServiceConfigSchema.parse(rawConfig);

  const dictEntries: [string, unknown][] = [
    ['Label', config.label],
  ];

  if (config.processType) {
    dictEntries.push(['ProcessType', config.processType]);
  }

  dictEntries.push(['ProgramArguments', config.programArguments]);

  if (config.workingDirectory) {
    dictEntries.push(['WorkingDirectory', config.workingDirectory]);
  }

  if (config.environmentVariables && Object.keys(config.environmentVariables).length > 0) {
    dictEntries.push(['EnvironmentVariables', config.environmentVariables]);
  }

  if (config.standardOutPath) {
    dictEntries.push(['StandardOutPath', config.standardOutPath]);
  }

  if (config.standardErrorPath) {
    dictEntries.push(['StandardErrorPath', config.standardErrorPath]);
  }

  if (config.runAtLoad !== undefined) {
    dictEntries.push(['RunAtLoad', config.runAtLoad]);
  }

  if (config.keepAlive !== undefined) {
    dictEntries.push(['KeepAlive', config.keepAlive]);
  }

  if (config.nice !== undefined) {
    dictEntries.push(['Nice', config.nice]);
  }

  if (config.throttleInterval !== undefined) {
    dictEntries.push(['ThrottleInterval', config.throttleInterval]);
  }

  if (config.startInterval !== undefined) {
    dictEntries.push(['StartInterval', config.startInterval]);
  }

  if (config.startCalendarInterval !== undefined) {
    dictEntries.push(['StartCalendarInterval', config.startCalendarInterval]);
  }

  if (config.exitTimeout !== undefined) {
    dictEntries.push(['ExitTimeOut', config.exitTimeout]);
  }

  if (config.softResourceLimits) {
    dictEntries.push(['SoftResourceLimits', config.softResourceLimits]);
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
  ];

  for (const [key, val] of dictEntries) {
    lines.push(`    <key>${escapeXml(key)}</key>`);
    lines.push(renderValue(val, 1));
  }

  lines.push('</dict>');
  lines.push('</plist>');
  lines.push('');

  return lines.join('\n');
}

export function validatePlistXml(xml: string): { valid: boolean; error?: string } {
  if (!xml.includes('<?xml') || !xml.includes('<plist') || !xml.includes('</plist>')) {
    return { valid: false, error: 'Missing XML declaration or plist root tags' };
  }
  if (!xml.includes('<key>Label</key>')) {
    return { valid: false, error: 'Missing required Label key' };
  }
  if (!xml.includes('<key>ProgramArguments</key>')) {
    return { valid: false, error: 'Missing required ProgramArguments key' };
  }
  // Check balanced tags for key, dict, array, string, integer
  const openTags = (xml.match(/<(key|dict|array|string|integer)>/g) || []).length;
  const closeTags = (xml.match(/<\/(key|dict|array|string|integer)>/g) || []).length;
  if (openTags !== closeTags) {
    return { valid: false, error: `Mismatched tags count: ${openTags} open vs ${closeTags} close` };
  }
  return { valid: true };
}
