function handler(event) {
  var request = event.request;
  var path = request.uri;
  var leaf = path.substring(path.lastIndexOf('/') + 1);
  if ((request.method === 'GET' || request.method === 'HEAD') && leaf.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
