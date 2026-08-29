// Beam UPnP IGD - zero-dependency port forwarding via SSDP + SOAP.
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { URL } from 'node:url';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_TIMEOUT = 3000;
const SOAP_TIMEOUT = 5000;

function log(...args) { console.log('[upnp]', ...args); }

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

function discoverGateway() {
  return new Promise((resolve) => {
    const locations = [];
    const socket = dgram.createSocket('udp4');
    const message = [
      'M-SEARCH * HTTP/1.1',
      'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT,
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: upnp:rootdevice',
      '', '',
    ].join('\r\n');
    socket.on('message', (buf) => {
      const text = buf.toString('utf8');
      const match = text.match(/LOCATION:\s*(.+)/i);
      if (match) {
        const loc = match[1].trim();
        if (!locations.includes(loc)) locations.push(loc);
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      try { socket.addMembership(SSDP_ADDR); } catch { /* ignore */ }
      socket.send(message, SSDP_PORT, SSDP_ADDR);
      setTimeout(() => { socket.close(); resolve(locations); }, SSDP_TIMEOUT);
    });
    socket.on('error', () => { socket.close(); resolve(locations); });
  });
}

function fetchUrl(urlStr, timeoutMs) {
  timeoutMs = timeoutMs || SOAP_TIMEOUT;
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(urlStr, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseControlUrl(xml) {
  const svc = xml.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1<\/serviceType>[\s\S]*?<\/service>/i);
  if (!svc) return null;
  const u = svc[0].match(/<controlURL>([^<]+)<\/controlURL>/i);
  return u ? u[1].trim() : null;
}

async function findControlUrl() {
  const locations = await discoverGateway();
  for (const loc of locations) {
    try {
      const xml = await fetchUrl(loc);
      const p = parseControlUrl(xml);
      if (p) {
        const base = new URL(loc);
        return base.protocol + '//' + base.host + p;
      }
    } catch (err) { log('device desc failed', loc, err.message); }
  }
  return null;
}

function soapAction(controlUrl, action, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(controlUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const soapBody =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' + body + '</s:Body></s:Envelope>';
    const headers = {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(soapBody),
      'SOAPAction': '"urn:schemas-upnp-org:service:WANIPConnection:1#' + action + '"',
      Connection: 'close',
    };
    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers, timeout: SOAP_TIMEOUT },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(soapBody);
    req.end();
  });
}

export async function forward(localPort) {
  try {
    const controlUrl = await findControlUrl();
    if (!controlUrl) return { ok: false, error: 'No UPnP gateway found' };
    const localIp = getLocalIp();
    const body =
      '<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">' +
      '<NewRemoteHost></NewRemoteHost>' +
      '<NewExternalPort>' + localPort + '</NewExternalPort>' +
      '<NewProtocol>TCP</NewProtocol>' +
      '<NewInternalPort>' + localPort + '</NewInternalPort>' +
      '<NewInternalClient>' + localIp + '</NewInternalClient>' +
      '<NewEnabled>1</NewEnabled>' +
      '<NewPortMappingDescription>Beam</NewPortMappingDescription>' +
      '<NewLeaseDuration>0</NewLeaseDuration>' +
      '</u:AddPortMapping>';
    await soapAction(controlUrl, 'AddPortMapping', body);
    log('forwarded', localPort, localIp);
    let externalIp = null;
    try { externalIp = await getExternalIp(); } catch { /* best effort */ }
    return { ok: true, externalIp };
  } catch (err) {
    log('forward failed', err.message);
    return { ok: false, error: err.message };
  }
}

export async function remove(localPort) {
  try {
    const controlUrl = await findControlUrl();
    if (!controlUrl) return;
    const body =
      '<u:DeletePortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">' +
      '<NewRemoteHost></NewRemoteHost>' +
      '<NewExternalPort>' + localPort + '</NewExternalPort>' +
      '<NewProtocol>TCP</NewProtocol>' +
      '</u:DeletePortMapping>';
    await soapAction(controlUrl, 'DeletePortMapping', body);
    log('removed', localPort);
  } catch (err) { log('remove failed (ignored)', err.message); }
}

export async function getExternalIp() {
  const controlUrl = await findControlUrl();
  if (!controlUrl) return null;
  const body =
    '<u:GetExternalIPAddress xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"></u:GetExternalIPAddress>';
  const res = await soapAction(controlUrl, 'GetExternalIPAddress', body);
  const m = res.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/);
  return m ? m[1].trim() : null;
}
