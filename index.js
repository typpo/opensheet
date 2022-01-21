const SPREADSHEET_URL_REGEX = /.*?\/d\/([^\/]+)(.*gid=(\d+))?/g;

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  if (event.request.headers.get('authorization') !== `Basic ${AUTH_KEY}`) {
    return new Response('unauthorized', {
      status: 401,
    });
  }

  const url = new URL(event.request.url);

  const { searchParams } = url;
  let id = searchParams.get('docId');
  let sheet = searchParams.get('sheet');
  const sheetUrl = searchParams.get('sheetUrl');

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

  const cacheKey = `https://127.0.0.1/${id}/${sheet}`;
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log(`Serving from cache: ${cacheKey}`);
    return cachedResponse;
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

  const rawRows = result.values || [];
  const headers = rawRows.shift();

  rawRows.forEach((row) => {
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
  });

  const respData = {
    // rows,
    cols,
  };

  const maxAge = event.request.headers.get('x-request-maxage');
  const apiResponse = new Response(JSON.stringify(respData), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `s-maxage=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });

  event.waitUntil(cache.put(cacheKey, apiResponse.clone()));

  return apiResponse;
}

const error = (message, status = 400) => {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
