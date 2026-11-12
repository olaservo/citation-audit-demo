// A sample MCP server for Ireland's open data portal, data.gov.ie. Its
// `statistics` tool answers with SEP-3094 citations to the datasets the
// figures come from. The catalogue records in corpus/datasets.json and the
// quoted rows are real, retrieved on 2026-11-11. The `unemployment` topic
// also returns flawed citations on purpose, so the auditor has something to
// find. Every flawed citation points at an invented dataset for the invented
// region of Northmark on data.example.org. The `inflation` topic returns none.
import { readFileSync } from 'node:fs';

import { CLIENT_CAPABILITIES_META_KEY, McpServer, type ClientCapabilities } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { CITATIONS_EXTENSION, type Citation } from './types.ts';

interface Answer {
    text: string;
    citations: Citation[];
}

const PORTAL = 'https://data.gov.ie/dataset';
const POPULATION = 'pea01-population-estimates-persons-in-april';
const UNEMPLOYMENT = 'mum01-seasonally-adjusted-monthly-unemployment';
const QUARTERLY = 'qlf51-quarterly-unemployment-and-long-term-unemployment-rate';
// Invented, in corpus/fictional-datasets.json.
const FICTIONAL = 'https://data.example.org/dataset';
const YOUTH = 'northmark-youth-unemployment';
const EARNINGS = 'northmark-weekly-earnings';

// Rows of the datasets' CSV files, quoted as a citation's `text`.
const row = {
    population2026: '"PEA01","Population Estimates (Persons in April)","2026","2026","-","All ages","-","Both sexes","Thousand","5525.6"',
    population2025: '"PEA01","Population Estimates (Persons in April)","2025","2025","-","All ages","-","Both sexes","Thousand","5458.6"',
    // Real. The corpus has no extract of this dataset, so the quote cannot be checked.
    longTerm: '"QLF51C02","Long-term unemployment rate","20262","2026Q2","-","Both sexes","-","All ages","-","Levels of Education (Levels  0-8)","%","1.3"',
    unemployment: '"MUM01C02","Seasonally Adjusted Monthly Unemployment Rate","202610","2026 October","316","15 - 74 years","-","Both sexes","%","4.8"'
};

/** A catalogue record: a subset of what CKAN's `package_show` returns for a dataset. */
interface Dataset {
    name: string;
    title: string;
    license_url?: string;
    organization?: { title: string } | null;
    /** The date the data was last updated. `metadata_modified` changes on every nightly harvest. */
    updated?: string;
}

const DATASETS = ['datasets.json', 'fictional-datasets.json'].flatMap(
    file => JSON.parse(readFileSync(new URL(`../corpus/${file}`, import.meta.url), 'utf8')) as Dataset[]
);

/** The citation for a catalogue dataset: its title, license, and publishing organization. */
function cite(slug: string, { id, ...extra }: Partial<Citation> = {}): Citation {
    const dataset = DATASETS.find(entry => entry.name === slug)!;
    return {
        // `id` first, so it leads the citation's JSON.
        ...(id && { id }),
        name: dataset.title,
        ...(dataset.license_url && { license: dataset.license_url }),
        ...(dataset.organization && { publisher: { type: 'Organization', name: dataset.organization.title } }),
        ...(dataset.updated && { datePublished: dataset.updated }),
        ...extra
    };
}

// SEP-3094 has a server omit `citations` for a client that did not declare
// support. With PORTAL_REQUIRE_RENDER=1 the portal goes further and does not
// answer a client that will not show them. The SEP does not define this.
const REQUIRE_RENDER = process.env.PORTAL_REQUIRE_RENDER === '1';
const REFUSAL =
    'The datasets behind this answer are licensed on condition of attribution. ' +
    `This portal answers only clients that declare they render citations (${CITATIONS_EXTENSION} with \`render\`).`;

const ANSWERS: Record<string, Answer> = {
    // Uses the SEP's three link forms: a bare marker, a marker with link text,
    // and an inline link keyed by `name`.
    population: {
        text: [
            `Ireland's population figures come from [PEA01 - Population Estimates (Persons in April), Central Statistics Office](${PORTAL}/${POPULATION}).`,
            'The population was estimated at 5,525,600 in April 2026 [c1],',
            'up from [5,458,600 a year earlier][c2].',
            '',
            `[c1]: ${PORTAL}/${POPULATION}`,
            `[c2]: ${PORTAL}/${POPULATION}`
        ].join('\n'),
        citations: [
            cite(POPULATION, { id: 'c1', text: row.population2026 }),
            // `url` adds a text fragment to the link definition. It selects the dataset's
            // title on its portal page, which does not show the rows.
            cite(POPULATION, {
                id: 'c2',
                url: `${PORTAL}/${POPULATION}#:~:text=Population%20Estimates%20(Persons%20in%20April)`,
                text: row.population2025
            }),
            cite(POPULATION, { name: 'PEA01 - Population Estimates (Persons in April), Central Statistics Office' })
        ]
    },

    unemployment: {
        text: [
            'The seasonally adjusted unemployment rate in Ireland was 4.8 percent in October 2026 [c1].',
            'The long-term unemployment rate was 1.3 percent in the second quarter of 2026.',
            'In the fictional region of Northmark, youth unemployment fell to 9.8 percent in October 2026 [c2].',
            'The Northmark rate is forecast to fall below 4.5 percent in 2027 [c3].',
            'Northmark regional figures are on the staging portal [c4].',
            'Average weekly earnings in Northmark rose 3.1 percent over the year [c6].',
            '',
            `[c1]: ${PORTAL}/${UNEMPLOYMENT}`,
            `[c2]: ${FICTIONAL}/${YOUTH}`,
            '[c4]: http://10.20.0.15/dataset/regional-unemployment',
            `[c6]: ${FICTIONAL}/${EARNINGS}`
        ].join('\n'),
        citations: [
            // Sound: the row is in the dataset.
            cite(UNEMPLOYMENT, { id: 'c1', text: row.unemployment }),
            // The invented dataset gives 12.4 percent.
            cite(YOUTH, { id: 'c2', text: 'Youth unemployment in Northmark fell to 9.8 percent in October 2026.' }),
            // No entry for [c3], which also has no link definition.

            // Not in the catalogue. Private destination and a file: thumbnail.
            {
                id: 'c4',
                name: 'Northmark Regional Unemployment (staging)',
                thumbnailUrl: 'file:///srv/ckan/storage/regional-chart.png',
                license: 'https://creativecommons.org/licenses/by/4.0/',
                publisher: { type: 'Organization', name: 'Portal staging' }
            },
            // No [c5] marker in the text: the dataset is credited for the whole answer.
            cite(QUARTERLY, { id: 'c5', url: `${PORTAL}/${QUARTERLY}`, text: row.longTerm }),
            // The sentence is in the invented dataset. Its record has a share-alike
            // license and no organization, so nobody is named to credit.
            cite(EARNINGS, { id: 'c6', text: 'Average weekly earnings in Northmark rose 3.1 percent over the year to the second quarter of 2026.' }),
            // None of id, name, or url.
            { description: 'Internal briefing on the labour market' }
        ]
    },

    // A real figure (CSO table CPM18) returned with no dataset behind it.
    inflation: {
        text: 'Consumer prices in Ireland rose 2.8 percent in the year to December 2025.',
        citations: []
    }
};

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'portal-server', version: '0.1.0' });

    mcp.registerTool(
        'statistics',
        {
            description: 'Answers a question about official statistics for Ireland, citing the datasets on data.gov.ie',
            inputSchema: { topic: z.enum(['population', 'unemployment', 'inflation']) }
        },
        ({ topic }, ctx) => {
            const answer = ANSWERS[topic]!;
            // Capabilities arrive per request on 2026-07-28 and from `initialize` before that.
            const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
            const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? mcp.server.getClientCapabilities();
            const declared = capabilities?.extensions?.[CITATIONS_EXTENSION] as { render?: unknown } | undefined;
            if (REQUIRE_RENDER && !declared?.render) return { isError: true, content: [{ type: 'text', text: REFUSAL }] };
            return {
                content: [{ type: 'text', text: answer.text }],
                ...(declared && answer.citations.length > 0 && { citations: answer.citations })
            };
        }
    );

    return mcp;
}

void serveStdio(buildServer);
console.error('[portal-server] serving over stdio');
