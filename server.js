var port = 3000;
var fs = require('fs');
var path = require('path');
var url = require('url');
var server = require('https');
var options = {
    key: fs.readFileSync('cert/key.pem').toString(),
    cert: fs.readFileSync('cert/cert.pem').toString()
};
var app;
app = server.createServer(options, serverHandler);
app.listen(port, process.env.IP || '0.0.0.0', function (error) {
    var addr = app.address();
    if (addr.address === '0.0.0.0') {
        addr.address = 'localhost';
    }

    var domainURL = 'https://' + addr.address + ':' + addr.port + '/demo/index.html';

    console.log('\n========================================================');
    console.log('  서버 스타트!! ' + domainURL);
    console.log('========================================================\n');
});

require('./dev/Signaling-Server')(app);

// ===== 서버 켤 때 옵션 및 조건 =====
function serverHandler(req, res) {
    try {
        var filename = path.join(process.cwd(), url.parse(req.url).pathname);
        var contentType = 'text/plain';

        // 콘텐츠 타입에 맞춰 화면에 보여주도록 하는 부분. 이게 없으면 화면에 텍스트파일로 나온다
        if (filename.toLowerCase().indexOf('.html') !== -1) {
            contentType = 'text/html';
        }
        if (filename.toLowerCase().indexOf('.css') !== -1) {
            contentType = 'text/css';
        }
        if (filename.toLowerCase().indexOf('.png') !== -1) {
            contentType = 'image/png';
        }

        fs.readFile(filename, 'binary', function (err, file) {
            if (err) {
                res.writeHead(500, {
                    'Content-Type': 'text/html'
                });
                res.write('404 Not Found: ' + path.join('/', url.parse(req.url).pathname) + '\n');
                res.end();
                return;
            }

            res.writeHead(200, {
                'Content-Type': contentType
            });
            res.write(file, 'binary');
            res.end();
        });
    } catch (e) {
        res.writeHead(404, {
            'Content-Type': 'text/plain'
        });
        res.write('<h1>Unexpected error:</h1><br><br>' + e.stack || e.message || JSON.stringify(e));
        res.end();
    }
}