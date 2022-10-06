const {handleOptions} = require('./cors');

const SPREADSHEET_URL_REGEX = /.*?\/d\/([^\/]+)(.*gid=(\d+))?/g;

function getValueOr0(x) {
  const parsed = parseInt(x, 10);
  if (isNaN(parsed)) {
    return 0;
  }
  return parsed;
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  if (event.request.method === 'OPTIONS') {
    return handleOptions(event.request);
  }

  let isPublic = false;
  if (event.request.headers.get('authorization') === `Basic ${PUBLIC_AUTH_KEY}`) {
    isPublic = true;
  } else if (event.request.headers.get('authorization') !== `Basic ${AUTH_KEY}`) {
    return new Response('unauthorized', {
      status: 401,
    });
  }

  const url = new URL(event.request.url);

  const { searchParams } = url;
  let id = searchParams.get('docId');
  let sheet = searchParams.get('sheet');
  const sheetUrl = searchParams.get('sheetUrl');
  const rowLimit = getValueOr0(searchParams.get('rowLimit'));
  const rowOffset = getValueOr0(searchParams.get('rowOffset'));

  if (!id && !sheetUrl) {
    return error('Must provide sheet id or url', 404);
  }

  if (sheetUrl) {
    const matches = sheetUrl.matchAll(SPREADSHEET_URL_REGEX);
    [...matches].forEach((match) => {
      id = match[1];
      sheet = match[3];
    });
  }

  if (sheet == null) {
    // Default to first sheet.
    sheet = '0';
  }

  const cacheKey = new Request(url.toString(), event.request);
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log(`Serving from cache: ${url.toString()}`);
    const cachedData = await cachedResponse.json();
    return new Response(JSON.stringify(cachedData), {
      headers: {
        'content-type': 'application/json',
        'x-opensheet-cache-status': 'HIT',
      },
    });
  } else {
    console.log(`Cache miss: ${cacheKey}`);
  }

  sheet = decodeURIComponent(sheet.replace(/\+/g, ' '));

  if (!isNaN(sheet)) {
    const sheetData = await (
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?key=${GOOGLE_API_KEY}`)
    ).json();

    if (sheetData.error) {
      console.error('Error loading doc:', sheetData.error.message);
      return error(sheetData.error.message);
    }

    const sheetNum = parseInt(sheet, 10);
    let sheetWithThisIndex = sheetData.sheets[sheetNum];
    if (!sheetWithThisIndex) {
      // The number is not an index... let's try gid
      sheetWithThisIndex = sheetData.sheets.filter(
        (sheetDatum) => sheetDatum.properties.sheetId === sheetNum,
      )[0];
      if (!sheetWithThisIndex) {
        console.error(`There is no sheet number ${sheet}`);
        return error(`There is no sheet number ${sheet}`);
      }
    }

    // This works because Google Sheets enforces uniqueness in sheet title.
    sheet = sheetWithThisIndex.properties.title;
  }

  const result = await (
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${sheet}?key=${GOOGLE_API_KEY}`,
    )
  ).json();

  if (result.error) {
    console.error('Error loading sheet:', result.error.message);
    return error(result.error.message);
  }

  const rows = [];
  const cols = {};

  let rawRows = result.values || [];
  const headers = rawRows.shift();

  if (rowLimit > 0) {
    rawRows = rawRows.slice(rowOffset);
  } else if (rowLimit < 0) {
    rawRows = rawRows.slice(0, rawRows.length + rowOffset);
  }

  const numRows = rawRows.length;
  const rowStartIndex = Math.max(0, rowLimit < 0 ? rowLimit + numRows : 0);
  const rowEndIndex = Math.min(numRows - 1, rowLimit <= 0 ? numRows : rowLimit - 1);
  rawRows.every((row, idx) => {
    if (idx < rowStartIndex) {
      return true;
    }
    if (idx > rowEndIndex) {
      return false;
    }
    const rowData = {};
    row.forEach((item, index) => {
      const col = headers[index];
      rowData[col] = item;
      if (!cols[col]) {
        cols[col] = [];
      }
      cols[col].push(item);
    });
    rows.push(rowData);
    return true;
  });

  const respData = {
    // rows,
    cols,
  };

  const maxAge = isPublic ? 60 : event.request.headers.get('x-request-maxage');
  const apiResponse = new Response(JSON.stringify(respData), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `s-maxage=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });

  // Reference https://developers.cloudflare.com/workers/examples/cache-api/
  event.waitUntil(cache.put(cacheKey, apiResponse.clone()));

  return apiResponse;
}

function error(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
