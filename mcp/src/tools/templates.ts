/**
 * Template tools - list_templates and create_from_template
 */

import { loadConfig } from '../config.js';
import { listFilesInFolder, readFileContent, writeNote, fileExists } from '../vault.js';

// ============================================================
// list_templates
// ============================================================

export const listTemplatesSchema = {
  name: 'list_templates',
  description: `List available templates from the configured templates folder.

Templates are markdown files stored in the templates folder (default: Config/Templates).
Returns template names without the .md extension.`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export interface ListTemplatesResult {
  templates: string[];
  folder: string;
}

export async function listTemplates(): Promise<ListTemplatesResult> {
  const config = await loadConfig();
  const templatesFolder = config.templatesFolder;

  const files = await listFilesInFolder(templatesFolder, '.md');
  const templates = files.map(f => f.replace(/\.md$/, ''));

  return {
    templates,
    folder: templatesFolder,
  };
}

// ============================================================
// create_from_template
// ============================================================

export const createFromTemplateSchema = {
  name: 'create_from_template',
  description: `Create a new note from a template with variable substitution.

Templates support {{variable}} syntax for dynamic content:
- {{week}} - ISO week (e.g., "2026-W02")
- {{date_range}} - Date range (e.g., "Jan 6-10, 2026")
- {{monday_date}}, {{tuesday_date}}, etc. - Individual day dates
- {{today}} - Today's date (YYYY-MM-DD)
- {{year}} - Current year
- Custom variables via the variables parameter`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      template: {
        type: 'string',
        description: 'Template name (without .md extension)',
      },
      output_path: {
        type: 'string',
        description: 'Path where the new note will be created (relative to vault)',
      },
      variables: {
        type: 'object',
        description: 'Key-value pairs for variable substitution',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['template', 'output_path'],
  },
};

export interface CreateFromTemplateInput {
  template: string;
  output_path: string;
  variables?: Record<string, string>;
}

export interface CreateFromTemplateResult {
  success: boolean;
  path: string;
  template: string;
}

/**
 * Get the Monday of the week containing the given date
 */
function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  return new Date(d.setDate(diff));
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get ISO week number
 */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Get ISO week year (may differ from calendar year at year boundaries)
 */
function getISOWeekYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

/**
 * Format month name (short form)
 */
function formatMonthShort(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short' });
}

/**
 * Build date range string like "Jan 6-10, 2026"
 */
function buildDateRange(monday: Date): string {
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const mondayMonth = formatMonthShort(monday);
  const fridayMonth = formatMonthShort(friday);
  const year = friday.getFullYear();

  if (mondayMonth === fridayMonth) {
    return `${mondayMonth} ${monday.getDate()}-${friday.getDate()}, ${year}`;
  } else {
    return `${mondayMonth} ${monday.getDate()} - ${fridayMonth} ${friday.getDate()}, ${year}`;
  }
}

/**
 * Get built-in template variables
 */
function getBuiltInVariables(): Record<string, string> {
  const today = new Date();
  const monday = getMondayOfWeek(today);

  const weekNum = getISOWeek(today);
  const weekYear = getISOWeekYear(today);
  const week = `${weekYear}-W${String(weekNum).padStart(2, '0')}`;

  // Get weekday dates
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  const weekdayDates: Record<string, string> = {};
  weekdays.forEach((day, index) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + index);
    weekdayDates[`${day}_date`] = formatDateISO(d);
  });

  return {
    week,
    date_range: buildDateRange(monday),
    today: formatDateISO(today),
    year: String(today.getFullYear()),
    ...weekdayDates,
  };
}

/**
 * Substitute variables in template content
 */
function substituteVariables(content: string, variables: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

export async function createFromTemplate(input: CreateFromTemplateInput): Promise<CreateFromTemplateResult> {
  const config = await loadConfig();

  // Check write permissions
  if (!config.writePermissions.allowWrite) {
    throw new Error('Write permission denied by configuration');
  }

  // Check if output path is in allowed folders
  if (config.writePermissions.allowedFolders.length > 0) {
    const isAllowed = config.writePermissions.allowedFolders.some(folder =>
      input.output_path.startsWith(folder) || input.output_path.startsWith(`${folder}/`)
    );
    if (!isAllowed) {
      throw new Error(`Write not allowed to path: ${input.output_path}. Allowed folders: ${config.writePermissions.allowedFolders.join(', ')}`);
    }
  }

  // Load template
  const templatePath = `${config.templatesFolder}/${input.template}.md`;
  if (!await fileExists(templatePath)) {
    throw new Error(`Template not found: ${input.template} (looked in ${templatePath})`);
  }

  const templateContent = await readFileContent(templatePath);

  // Merge built-in variables with custom variables
  const builtInVars = getBuiltInVariables();
  const allVariables = { ...builtInVars, ...input.variables };

  // Substitute variables
  const outputContent = substituteVariables(templateContent, allVariables);

  // Write the new note
  await writeNote(input.output_path, outputContent);

  return {
    success: true,
    path: input.output_path,
    template: input.template,
  };
}
