import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import fetch from 'node-fetch';

const port = parseInt(process.env.PORT || '8080', 10);
const api_keys = JSON.parse(process.env.API_KEYS);
const upstreamUrl = 'https://api.anthropic.com/v1/complete';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];

function filterRequestBody(body) {
  // List of allowed main keys
  const allowedMainKeys = ["metadata", "model", "prompt", "max_tokens_to_sample", "temperature", "top_p", "top_k", "stream"];

  // Filter main keys
  let filteredBody = Object.keys(body)
    .filter(key => allowedMainKeys.includes(key))
    .reduce((obj, key) => {
      obj[key] = body[key];
      return obj;
    }, {});

  // Filter metadata to only keep 'user_id'
  if (filteredBody.metadata && filteredBody.metadata.user_id) {
    let filteredMetadata = { user_id: filteredBody.metadata.user_id };
    filteredBody.metadata = filteredMetadata;
  }

  return filteredBody;
}

const retryFetch = async (url, options) => {
  let lastError;
  for (let i = 0; i < 2; i++) {
    try {
      options.headers['x-api-key'] = randomChoice(api_keys);
      const response = await fetch(url, options);
      if ([401, 429].includes(response.status)) {
        lastError = response;
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const app = express();
app.disable('etag');
app.disable('x-powered-by');
app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).set(corsHeaders).type('text/plain').send(err.message);
  }
  next();
});

const handleOptions = (req, res) => {
  res.setHeader('Access-Control-Max-Age', '1728000').set(corsHeaders).sendStatus(204);
};

const handlePost = async (req, res) => {
  const contentType = req.headers['content-type'];
  if (!contentType || contentType !== 'application/json') {
    return res.status(415).set(corsHeaders).type('text/plain').send("Unsupported media type. Use 'application/json' content type");
  }

  const { stream } = req.body;
  if (stream != null && stream !== true && stream !== false) {
    return res.status(400).set(corsHeaders).type('text/plain').send('The `stream` parameter must be a boolean value');
  }

  try {
    const authHeader = req.get('x-api-key');
    if (authHeader !== process.env.PROXY_KEY) {
      return res.status(401).set(corsHeaders).type('text/plain').send('Unauthorized.');
    }
    const authHeaderUpstream = randomChoice(api_keys);

    const requestHeader = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': authHeaderUpstream,
      'User-Agent': 'Anthropic/Python 0.3.1',
      'anthropic-version': '2023-06-01'
    };
    let filteredBody = filterRequestBody(req.body);

    const resUpstream = await retryFetch(upstreamUrl, {
      method: 'POST',
      headers: requestHeader,
      body: JSON.stringify(filteredBody),
    });

    if (!resUpstream.ok) {
      const { status } = resUpstream;
      const text = await resUpstream.text();
      return res.status(status).set(corsHeaders).type('text/plain').send(text);
    }

    const contentType = resUpstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    const contentLength = resUpstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (stream) {
      res.setHeader('Connection', 'keep-alive');
    }
    res.set({
      ...corsHeaders,
      'Cache-Control': 'no-cache',
    });

    resUpstream.body.pipe(res);
  } catch (error) {
    res.status(500).set(corsHeaders).type('text/plain').send(error.message);
  }
};

app.options('/v1/complete', handleOptions);
app.post('/v1/complete', handlePost);

app.use('*', (req, res) => {
  res.status(404).set(corsHeaders).type('text/plain').send('Not found');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
