/* Bureau du Courrier — écriture de classeurs Excel (.xlsx).

   Un .xlsx est une archive ZIP contenant des fichiers XML. Tout est écrit ici à
   la main : aucune bibliothèque, ni dans le navigateur ni sur le serveur.

   L'archive est écrite sans compression (méthode « store ») : pour quelques
   centaines de lignes, le gain serait négligeable, et cela évite d'embarquer un
   compresseur. Excel, LibreOffice et Numbers ouvrent ces fichiers tels quels.

   Le classeur produit a un en-tête figé, des filtres, des largeurs de colonnes
   adaptées et des dates reconnues comme telles — de quoi trier et filtrer sans
   retoucher le fichier. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.xlsx = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- CRC32 ---------- */

  const CRC_TABLE = (function () {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }

  /* ---------- ZIP ---------- */

  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    const num = function (value, octets) {
      const out = new Uint8Array(octets);
      for (let i = 0; i < octets; i++) out[i] = (value >>> (i * 8)) & 0xff;
      return out;
    };

    files.forEach(function (file) {
      const name = utf8(file.name);
      const data = utf8(file.content);
      const sum = crc32(data);

      const local = [
        num(0x04034b50, 4),
        num(20, 2), // version minimale
        num(0x0800, 2), // noms en UTF-8
        num(0, 2), // stockage sans compression
        num(0, 2), // heure
        num(0x21, 2), // date : 1er janvier 1980, valeur neutre et reproductible
        num(sum, 4),
        num(data.length, 4),
        num(data.length, 4),
        num(name.length, 2),
        num(0, 2),
        name,
        data
      ];
      local.forEach(function (part) {
        chunks.push(part);
      });

      central.push([
        num(0x02014b50, 4),
        num(20, 2),
        num(20, 2),
        num(0x0800, 2),
        num(0, 2),
        num(0, 2),
        num(0x21, 2),
        num(sum, 4),
        num(data.length, 4),
        num(data.length, 4),
        num(name.length, 2),
        num(0, 2),
        num(0, 2),
        num(0, 2),
        num(0, 2),
        num(0, 4),
        num(offset, 4),
        name
      ]);

      offset += local.reduce(function (total, part) {
        return total + part.length;
      }, 0);
    });

    const debutCentral = offset;
    let tailleCentral = 0;
    central.forEach(function (entry) {
      entry.forEach(function (part) {
        chunks.push(part);
        tailleCentral += part.length;
      });
    });

    [
      num(0x06054b50, 4),
      num(0, 2),
      num(0, 2),
      num(files.length, 2),
      num(files.length, 2),
      num(tailleCentral, 4),
      num(debutCentral, 4),
      num(0, 2)
    ].forEach(function (part) {
      chunks.push(part);
    });

    const total = chunks.reduce(function (t, c) {
      return t + c.length;
    }, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach(function (c) {
      out.set(c, pos);
      pos += c.length;
    });
    return out;
  }

  /* ---------- feuille ---------- */

  function escapeXml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  /** A, B … Z, AA, AB … pour la colonne n (1 = A). */
  function colName(n) {
    let name = '';
    while (n > 0) {
      const reste = (n - 1) % 26;
      name = String.fromCharCode(65 + reste) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  /** Excel compte les jours depuis le 1900-01-00, avec le bogue du 29 février 1900. */
  function toExcelDate(date) {
    const ms = date.getTime() - date.getTimezoneOffset() * 60000;
    return ms / 86400000 + 25569;
  }

  function cell(ref, value, style) {
    if (value === null || value === undefined || value === '') {
      return '<c r="' + ref + '" s="' + style + '"/>';
    }
    if (value instanceof Date) {
      return '<c r="' + ref + '" s="' + style + '"><v>' + toExcelDate(value) + '</v></c>';
    }
    if (typeof value === 'number' && isFinite(value)) {
      return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
    }
    return (
      '<c r="' + ref + '" t="inlineStr" s="' + style + '"><is><t xml:space="preserve">' +
      escapeXml(value) +
      '</t></is></c>'
    );
  }

  /**
   * Construit le classeur.
   *   columns : [{ key, label, width, type }]  type 'date' pour la mise en forme
   *   rows    : tableau d'objets
   * Renvoie un Uint8Array prêt à être enregistré.
   */
  function build(options) {
    const opts = options || {};
    const columns = opts.columns || [];
    const rows = opts.rows || [];
    const titre = escapeXml(opts.sheetName || 'Feuille1').slice(0, 31);

    const STYLE_ENTETE = 1;
    const STYLE_TEXTE = 2;
    const STYLE_DATE = 3;

    const lignes = [];
    lignes.push(
      '<row r="1" ht="22" customHeight="1">' +
        columns
          .map(function (col, i) {
            return cell(colName(i + 1) + '1', col.label, STYLE_ENTETE);
          })
          .join('') +
        '</row>'
    );

    rows.forEach(function (row, r) {
      const numero = r + 2;
      lignes.push(
        '<row r="' + numero + '">' +
          columns
            .map(function (col, i) {
              const brut = row[col.key];
              const style = col.type === 'date' ? STYLE_DATE : STYLE_TEXTE;
              return cell(colName(i + 1) + numero, brut, style);
            })
            .join('') +
          '</row>'
      );
    });

    const derniere = colName(Math.max(columns.length, 1));
    const plage = 'A1:' + derniere + Math.max(rows.length + 1, 1);

    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0" showGridLines="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' +
      columns
        .map(function (col, i) {
          return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (col.width || 18) + '" customWidth="1"/>';
        })
        .join('') +
      '</cols>' +
      '<sheetData>' +
      lignes.join('') +
      '</sheetData>' +
      '<autoFilter ref="' + plage + '"/>' +
      '</worksheet>';

    const styles =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts>' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><color rgb="FFF4F0E6"/><sz val="11"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF16233F"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFCFC6AE"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
      '<xf xfId="0" numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1">' +
      '<alignment vertical="center"/></xf>' +
      '<xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1">' +
      '<alignment vertical="center"/></xf>' +
      '<xf xfId="0" numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>' +
      '</cellXfs>' +
      // Sans style nommé « Normal », certains lecteurs signalent un classeur
      // sans style par défaut et appliquent le leur.
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    const workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + titre + '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';

    return zip([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>'
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      },
      { name: 'xl/workbook.xml', content: workbook },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>'
      },
      { name: 'xl/styles.xml', content: styles },
      { name: 'xl/worksheets/sheet1.xml', content: sheet }
    ]);
  }

  return { build: build, crc32: crc32, colName: colName, toExcelDate: toExcelDate };
});
