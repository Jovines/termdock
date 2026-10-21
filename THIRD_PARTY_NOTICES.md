# Third-party notices

## Maple Mono / Termdock Maple

Terminal text uses Maple Mono 7.800 from `@fontsource/maple-mono` 5.3.0,
https://github.com/subframe7536/maple-font. Copyright (c) 2022, subframe7536.
The unmodified source faces and SIL Open Font License 1.1 ship under
`public/fonts/MapleMono-*.woff2` and `public/fonts/MapleMono-OFL.txt`.
Generated web subsets are renamed **Termdock Maple** in accordance with the
reserved font name; glyph outlines and character advances are preserved.
The compact **Termdock Prompt Icons** subsets derive from the existing
JetBrains Mono NL Nerd Font Mono sources, preserving their copyright/license
metadata and glyph outlines, and supply first-frame shell prompt icons.

## oh-my-mermaid

Architecture Mermaid diff utilities and scanner conventions derive from
https://github.com/oh-my-mermaid/oh-my-mermaid, commit
38ccdb69298adec949177c92c88d6e3ddfb5bab7. Adaptations use Termdock transport,
project boundaries, document validation and design tokens.

MIT License

Copyright (c) 2025 oh-my-mermaid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## WebTransport / QUIC

Optional QUIC support uses `@fails-components/webtransport` and
`@fails-components/webtransport-transport-http3-quiche` 1.6.11,
https://github.com/fails-components/webtransport. Their distributed packages
include the original Chromium (BSD), Envoy (Apache 2.0), and native dependency
license notices; retain those files when redistributing the native runtime.

This packages uses the libraries abseil, boringssl, quiche and zlib,
these fall under their respective license.

Portions of the code of this package, e.g. the platform implementation for libquiche,
are taken from the Chromium project and libquiche and envoy project.
Basically for files taken from the Chromium project and libquiche the modfied BSD 3-Clause (see LICENSE.chromium) applies, where for the files taken from the envoy a Apache 2.0 (LICENSE.envoy) applies.

For all new files (except FAILS logo) and modifications of the original files the following
BSD 3-Clause license applies:


Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    (1) Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    (2) Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

    (3)The name of the authors, FAILS or contributing organizations
    (company, organsations etc.)  may not be used to
    endorse or promote products derived from this software without
    specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## Short-lived QUIC certificate generation

`@peculiar/x509` 2.2.0, https://github.com/PeculiarVentures/x509.

MIT License

Copyright (c) Peculiar Ventures. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

`reflect-metadata` 0.2.2, https://github.com/rbuckton/reflect-metadata,
Copyright (c) Microsoft Corporation. Apache License 2.0; the package includes
its full LICENSE and NOTICE files.
