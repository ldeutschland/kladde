#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#import "pdf_editing.h"

enum {
    EditDone = 0,
    EditUnreadable = 1,
    EditProtected = 2,
    EditInvalid = 3,
    EditUnwritable = 4,
};

static const CGFloat markerAlpha = 0.35;
static const CGFloat arrowRoom = 5;
static const CGFloat textPadding = 0.5;
static NSString *const textFont = @"Helvetica";

CGSize kladde_shown_size(PDFPage *page) {
    CGRect bounds = [page boundsForBox:kPDFDisplayBoxCropBox];
    return CGRectApplyAffineTransform(bounds, [page transformForBox:kPDFDisplayBoxCropBox]).size;
}

static CGAffineTransform displayToPage(PDFPage *page) {
    CGAffineTransform flip = CGAffineTransformMake(1, 0, 0, -1, 0, kladde_shown_size(page).height);
    return CGAffineTransformConcat(flip, CGAffineTransformInvert([page transformForBox:kPDFDisplayBoxCropBox]));
}

static PDFDocument *openDocument(const uint8_t *bytes, size_t length) {
    NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
    PDFDocument *document = [[PDFDocument alloc] initWithData:data];
    if (!document || document.isLocked || !document.pageCount) return nil;
    return document;
}

static BOOL readNumber(id value, CGFloat *number) {
    if (![value isKindOfClass:NSNumber.class]) return NO;
    double read = [value doubleValue];
    if (!isfinite(read)) return NO;
    *number = read;
    return YES;
}

static BOOL readPoint(id value, CGAffineTransform map, CGPoint *point) {
    if (![value isKindOfClass:NSArray.class] || [value count] != 2) return NO;
    CGFloat x, y;
    if (!readNumber(value[0], &x) || !readNumber(value[1], &y)) return NO;
    *point = CGPointApplyAffineTransform(CGPointMake(x, y), map);
    return YES;
}

static NSMutableData *readPoints(id value, CGAffineTransform map) {
    if (![value isKindOfClass:NSArray.class] || ![value count]) return nil;
    NSMutableData *points = [NSMutableData dataWithLength:[value count] * sizeof(CGPoint)];
    CGPoint *write = points.mutableBytes;
    for (NSUInteger i = 0; i < [value count]; i++)
        if (!readPoint(value[i], map, &write[i])) return nil;
    return points;
}

static PDFKitPlatformColor *readColor(id value, CGFloat alpha) {
    if (![value isKindOfClass:NSString.class] || [value length] != 7 || ![value hasPrefix:@"#"]) return nil;
    unsigned int rgb = 0;
    NSScanner *scanner = [NSScanner scannerWithString:[value substringFromIndex:1]];
    if (![scanner scanHexInt:&rgb] || !scanner.isAtEnd) return nil;
    return [PDFKitPlatformColor colorWithRed:((rgb >> 16) & 0xff) / 255.0
                                       green:((rgb >> 8) & 0xff) / 255.0
                                        blue:(rgb & 0xff) / 255.0
                                       alpha:alpha];
}

static CGRect enclosing(const CGPoint *points, NSUInteger count, CGFloat margin) {
    CGRect box = CGRectMake(points[0].x, points[0].y, 0, 0);
    for (NSUInteger i = 1; i < count; i++) box = CGRectUnion(box, CGRectMake(points[i].x, points[i].y, 0, 0));
    return CGRectInset(box, -margin, -margin);
}

static CGPoint relative(CGPoint point, CGRect box) {
    return CGPointMake(point.x - box.origin.x, point.y - box.origin.y);
}

static void lineTo(PDFKitPlatformBezierPath *path, CGPoint point) {
#if TARGET_OS_OSX
    [path lineToPoint:point];
#else
    [path addLineToPoint:point];
#endif
}

static PDFAnnotation *ink(const CGPoint *points, NSUInteger count, CGFloat width) {
    CGRect box = enclosing(points, count, width);
    PDFAnnotation *mark = [[PDFAnnotation alloc] initWithBounds:box forType:PDFAnnotationSubtypeInk withProperties:nil];
    PDFKitPlatformBezierPath *path = [PDFKitPlatformBezierPath bezierPath];
    [path moveToPoint:relative(points[0], box)];
    for (NSUInteger i = count > 1 ? 1 : 0; i < count; i++) lineTo(path, relative(points[i], box));
    [mark addBezierPath:path];
    return mark;
}

static PDFAnnotation *frame(const CGPoint *points, CGFloat width) {
    CGRect box = enclosing(points, 2, width / 2);
    return [[PDFAnnotation alloc] initWithBounds:box forType:PDFAnnotationSubtypeSquare withProperties:nil];
}

static PDFAnnotation *arrow(const CGPoint *points, CGFloat width) {
    CGRect box = enclosing(points, 2, width * arrowRoom);
    PDFAnnotation *mark = [[PDFAnnotation alloc] initWithBounds:box forType:PDFAnnotationSubtypeLine withProperties:nil];
    mark.startPoint = relative(points[0], box);
    mark.endPoint = relative(points[1], box);
    mark.endLineStyle = kPDFLineStyleOpenArrow;
    return mark;
}

static PDFAnnotation *shape(id kind, const CGPoint *points, NSUInteger count, CGFloat width) {
    if ([kind isEqual:@"pen"] || [kind isEqual:@"marker"]) return ink(points, count, width);
    if ([kind isEqual:@"rect"] && count == 2) return frame(points, width);
    if ([kind isEqual:@"arrow"] && count == 2) return arrow(points, width);
    return nil;
}

static PDFBorder *borderOf(CGFloat width) {
    PDFBorder *border = [PDFBorder new];
    border.lineWidth = width;
    return border;
}

static BOOL addShape(PDFPage *page, NSDictionary *mark, CGAffineTransform map) {
    CGFloat width;
    NSMutableData *points = readPoints(mark[@"points"], map);
    if (!points || !readNumber(mark[@"width"], &width) || width <= 0) return NO;
    PDFKitPlatformColor *color = readColor(mark[@"color"], [mark[@"kind"] isEqual:@"marker"] ? markerAlpha : 1);
    PDFAnnotation *annotation = shape(mark[@"kind"], points.bytes, points.length / sizeof(CGPoint), width);
    if (!color || !annotation) return NO;
    annotation.color = color;
    annotation.border = borderOf(width);
    [page addAnnotation:annotation];
    return YES;
}

static PDFAnnotation *note(PDFPage *page, CGPoint anchor, NSString *text, CGFloat size) {
    PDFKitPlatformFont *font = [PDFKitPlatformFont fontWithName:textFont size:size];
    if (!font) return nil;
    CGSize measured = [text boundingRectWithSize:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)
                                         options:NSStringDrawingUsesLineFragmentOrigin
                                      attributes:@{NSFontAttributeName: font}
                                         context:nil].size;
    CGAffineTransform toPage = displayToPage(page);
    CGPoint corner = CGPointApplyAffineTransform(anchor, CGAffineTransformInvert(toPage));
    CGFloat padding = size * textPadding;
    CGRect shown = CGRectMake(corner.x, corner.y, ceil(measured.width + 2 * padding), ceil(measured.height + padding));
    CGRect box = CGRectStandardize(CGRectApplyAffineTransform(shown, toPage));
    PDFAnnotation *mark = [[PDFAnnotation alloc] initWithBounds:box forType:PDFAnnotationSubtypeFreeText withProperties:nil];
    mark.contents = text;
    mark.font = font;
    mark.color = PDFKitPlatformColor.clearColor;
    return mark;
}

static BOOL addNote(PDFPage *page, NSDictionary *mark, CGAffineTransform map) {
    CGPoint anchor;
    CGFloat size;
    id points = mark[@"points"], text = mark[@"text"];
    if (![points isKindOfClass:NSArray.class] || [points count] != 1 || !readPoint(points[0], map, &anchor)) return NO;
    if (![text isKindOfClass:NSString.class] || ![text length] || !readNumber(mark[@"width"], &size) || size <= 0) return NO;
    PDFKitPlatformColor *color = readColor(mark[@"color"], 1);
    PDFAnnotation *annotation = note(page, anchor, text, size);
    if (!color || !annotation) return NO;
    annotation.fontColor = color;
    [page addAnnotation:annotation];
    return YES;
}

static BOOL isNote(NSDictionary *mark) {
    return [mark[@"kind"] isEqual:@"text"];
}

static BOOL editPage(PDFPage *page, id plan) {
    CGFloat turn;
    if (![plan isKindOfClass:NSDictionary.class] || !readNumber(plan[@"turn"], &turn) || fmod(turn, 90) != 0) return NO;
    NSArray *marks = plan[@"marks"];
    if (![marks isKindOfClass:NSArray.class]) return NO;
    CGAffineTransform original = displayToPage(page);
    for (NSDictionary *mark in marks) {
        if (![mark isKindOfClass:NSDictionary.class]) return NO;
        if (!isNote(mark) && !addShape(page, mark, original)) return NO;
    }
    page.rotation = ((page.rotation + (NSInteger)turn) % 360 + 360) % 360;
    for (NSDictionary *mark in marks)
        if (isNote(mark) && !addNote(page, mark, original)) return NO;
    return YES;
}

static NSArray<NSNumber *> *sourcesOf(NSArray *pages, NSUInteger count) {
    NSMutableArray<NSNumber *> *order = [NSMutableArray array];
    NSMutableIndexSet *seen = [NSMutableIndexSet indexSet];
    for (id page in pages) {
        CGFloat source;
        if (![page isKindOfClass:NSDictionary.class] || !readNumber(page[@"source"], &source)) return nil;
        if (source < 0 || source >= count || floor(source) != source || [seen containsIndex:(NSUInteger)source]) return nil;
        [seen addIndex:(NSUInteger)source];
        [order addObject:@((NSUInteger)source)];
    }
    return order.count ? order : nil;
}

static void arrange(PDFDocument *document, NSArray<PDFPage *> *originals, NSArray<NSNumber *> *order) {
    NSMutableIndexSet *kept = [NSMutableIndexSet indexSet];
    for (NSNumber *source in order) [kept addIndex:source.unsignedIntegerValue];
    for (NSUInteger i = originals.count; i-- > 0;)
        if (![kept containsIndex:i]) [document removePageAtIndex:i];
    for (NSUInteger i = 0; i < order.count; i++) {
        NSUInteger at = [document indexForPage:originals[order[i].unsignedIntegerValue]];
        if (at != i) [document exchangePageAtIndex:at withPageAtIndex:i];
    }
}

static int applyEdit(PDFDocument *document, id edit) {
    if (![edit isKindOfClass:NSDictionary.class] || ![edit[@"pages"] isKindOfClass:NSArray.class]) return EditInvalid;
    NSArray *pages = edit[@"pages"];
    NSArray<NSNumber *> *order = sourcesOf(pages, document.pageCount);
    if (!order) return EditInvalid;
    NSMutableArray<PDFPage *> *originals = [NSMutableArray array];
    for (NSUInteger i = 0; i < document.pageCount; i++) [originals addObject:[document pageAtIndex:i]];
    for (NSUInteger i = 0; i < pages.count; i++)
        if (!editPage(originals[order[i].unsignedIntegerValue], pages[i])) return EditInvalid;
    arrange(document, originals, order);
    return EditDone;
}

size_t kladde_pdf_pages(const uint8_t *bytes, size_t length, double *sizes, size_t capacity, bool *editable) {
    @autoreleasepool {
        @try {
            PDFDocument *document = openDocument(bytes, length);
            if (!document) return 0;
            for (NSUInteger i = 0; i < MIN(document.pageCount, capacity); i++) {
                CGSize shown = kladde_shown_size([document pageAtIndex:i]);
                sizes[2 * i] = shown.width;
                sizes[2 * i + 1] = shown.height;
            }
            *editable = document.allowsDocumentChanges && document.allowsCommenting;
            return document.pageCount;
        } @catch (NSException *exception) {
            return 0;
        }
    }
}

int kladde_pdf_edit(const uint8_t *bytes, size_t length, const uint8_t *plan, size_t planLength, void *result,
                    void (*copy)(void *, const uint8_t *, size_t)) {
    @autoreleasepool {
        @try {
            PDFDocument *document = openDocument(bytes, length);
            if (!document) return EditUnreadable;
            if (!document.allowsDocumentChanges || !document.allowsCommenting) return EditProtected;
            NSData *json = [NSData dataWithBytesNoCopy:(void *)plan length:planLength freeWhenDone:NO];
            int status = applyEdit(document, [NSJSONSerialization JSONObjectWithData:json options:0 error:nil]);
            if (status != EditDone) return status;
            NSData *written = document.dataRepresentation;
            if (!written.length) return EditUnwritable;
            copy(result, written.bytes, written.length);
            return EditDone;
        } @catch (NSException *exception) {
            return EditUnreadable;
        }
    }
}
